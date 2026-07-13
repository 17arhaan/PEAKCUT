"""Front door: local file or URL in, `SourceMedia` out.

`resolve()` is the only entrypoint the pipeline calls. A local path is a
passthrough (probe + extract wav); a URL goes through yt-dlp first. Both
paths enforce the same duration/size caps before the heavy work (transcode
for local, download for URL) runs.
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from shorts.ffmpeg import extract_wav, probe
from shorts.types import SourceMedia

MAX_DURATION_S = 3 * 3600
MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024

# Best available format at or below 1080p; mp4 container preferred (falls
# back to whatever's offered if the site doesn't have mp4 at that height).
YT_DLP_FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b"


@dataclass
class IngestError(Exception):
    code: str
    message: str

    def __str__(self) -> str:
        return self.message


def _is_url(source: str) -> bool:
    return urlparse(source).scheme in ("http", "https")


def _check_caps(duration_s: float, size_bytes: int) -> None:
    if duration_s > MAX_DURATION_S:
        raise IngestError(
            "TOO_LONG",
            f"Source is {duration_s / 3600:.1f}h long; the max is {MAX_DURATION_S / 3600:.0f}h.",
        )
    if size_bytes > MAX_SIZE_BYTES:
        raise IngestError(
            "TOO_BIG",
            f"Source is {size_bytes / 1e9:.2f}GB; the max is {MAX_SIZE_BYTES / 1e9:.0f}GB.",
        )


# yt-dlp stderr substring (lower-cased) -> (code, user-readable message).
# Order matters: first match wins. Wording sourced from yt-dlp's own error
# classes/messages (yt_dlp/extractor/common.py raise_geo_restricted /
# raise_login_required, youtube/_video.py's age-gate detection) plus the
# stdlib urllib/socket error text that surfaces for DNS/connect failures.
_ERROR_PATTERNS: list[tuple[str, str, str]] = [
    # GeoRestrictedError's default message, plus YouTube's own wording.
    ("not available from your location", "GEO_BLOCKED", "This video isn't available in your region."),
    ("not available in your country", "GEO_BLOCKED", "This video isn't available in your region."),
    ("geo restrict", "GEO_BLOCKED", "This video isn't available in your region."),
    # YouTube age gate: "Sign in to confirm your age. This video may be
    # inappropriate for some users."
    ("confirm your age", "AGE_GATED", "This video is age-restricted and requires sign-in to view."),
    ("age-restrict", "AGE_GATED", "This video is age-restricted and requires sign-in to view."),
    ("inappropriate for some users", "AGE_GATED", "This video is age-restricted and requires sign-in to view."),
    # Removed / private / deleted / terminated-channel.
    ("video unavailable", "UNAVAILABLE", "This video is unavailable (removed, private, or deleted)."),
    ("this video is private", "UNAVAILABLE", "This video is private."),
    ("has been removed", "UNAVAILABLE", "This video has been removed."),
    ("no longer available", "UNAVAILABLE", "This video is no longer available."),
    ("account associated with this video has been terminated", "UNAVAILABLE", "This video is unavailable (channel terminated)."),
    ("this video does not exist", "UNAVAILABLE", "This video does not exist."),
    # DNS / connectivity failures, as surfaced by urllib/socket through
    # yt-dlp's network layer.
    ("urlopen error", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("failed to resolve", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("temporary failure in name resolution", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("getaddrinfo failed", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("name or service not known", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("nodename nor servname", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("connection refused", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("network is unreachable", "NETWORK", "Network error while reaching the video source. Try again later."),
    ("timed out", "NETWORK", "Network error while reaching the video source. Try again later."),
]


def _map_yt_dlp_error(stderr: bytes) -> IngestError:
    text = stderr.decode("utf-8", errors="replace")
    lower = text.lower()
    for pattern, code, message in _ERROR_PATTERNS:
        if pattern in lower:
            return IngestError(code, message)
    # Unknown failure shape -- UNAVAILABLE with the stderr tail attached so
    # it's still debuggable, per the task brief.
    tail = "\n".join(text.strip().splitlines()[-10:])
    return IngestError("UNAVAILABLE", f"Could not download this video: {tail}")


def _preflight_caps(url: str) -> None:
    """Check duration/size via yt-dlp metadata BEFORE downloading, so a
    10GB video that's over cap never gets pulled just to be rejected.
    `--print`/`-O` implies --simulate: no download happens here."""
    args = ["yt-dlp", "--no-warnings", "-O", "%(duration)s", "-O", "%(filesize_approx)s", url]
    proc = subprocess.run(args, capture_output=True, check=False)
    if proc.returncode != 0:
        # The pre-flight metadata fetch hits the same site gates (geo/age/
        # removed) a real download would -- route it through the same
        # classifier rather than a second one.
        raise _map_yt_dlp_error(proc.stderr)

    lines = proc.stdout.decode("utf-8", errors="replace").strip().splitlines()
    duration_str = lines[0] if lines else "NA"
    size_str = lines[1] if len(lines) > 1 else "NA"

    # yt-dlp prints "NA" when a field is unknown for this extractor/video --
    # treat missing as pass; the post-download stat is the backstop.
    duration = None if duration_str in ("NA", "") else float(duration_str)
    size = None if size_str in ("NA", "") else float(size_str)
    _check_caps(duration or 0.0, int(size or 0))


def _download_url(url: str, workdir: Path) -> Path:
    _preflight_caps(url)

    out_template = str(workdir / "source.%(ext)s")
    args = [
        "yt-dlp",
        "--no-warnings",
        # Network resilience: a "[SSL] record layer failure" on googlevideo is
        # almost always a bad IPv6 path, so pin IPv4; bound socket hangs and
        # keep retrying fragments so a momentary TLS drop doesn't fail the job.
        "--force-ipv4",
        "--socket-timeout", "30",
        "--retries", "10",
        "--fragment-retries", "10",
        "-f", YT_DLP_FORMAT,
        "--merge-output-format", "mp4",
        "-o", out_template,
        url,
    ]
    # ponytail: subprocess + CLI, not the yt-dlp python API -- keeps this
    # seam testable with mocked subprocess.run (same discipline as
    # ffmpeg.py) and insulates us from yt-dlp's unstable internal API.
    proc = subprocess.run(args, capture_output=True, check=False)
    if proc.returncode != 0:
        raise _map_yt_dlp_error(proc.stderr)

    downloaded = sorted(workdir.glob("source.*"))
    if not downloaded:
        raise IngestError("UNAVAILABLE", "yt-dlp reported success but wrote no file.")
    return downloaded[0]


def resolve(source: str, workdir: Path) -> SourceMedia:
    source = str(source)
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    if _is_url(source):
        video_path = _download_url(source, workdir)
    else:
        video_path = Path(source)
        if not video_path.exists():
            raise IngestError("UNAVAILABLE", f"Local file not found: {source}")

    info = probe(video_path)
    # Backstop for URLs (pre-flight metadata can be "NA"); primary check for
    # local files. Runs before extract_wav, the remaining heavy step.
    _check_caps(info.duration_s, video_path.stat().st_size)

    wav = extract_wav(video_path, workdir / "audio.wav")
    return SourceMedia(video=video_path, wav16k=wav, info=info)
