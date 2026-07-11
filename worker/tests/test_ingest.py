"""ingest.py tests.

Local-path passthrough is real (fast: a 1s lavfi-generated clip). Everything
that talks to yt-dlp is mocked at the subprocess.run seam -- one fake per
error class, asserting the mapped IngestError code + a non-empty
user-readable message. Caps (TOO_LONG/TOO_BIG) are exercised twice: once via
a mocked probe() for local files, once via mocked yt-dlp pre-flight metadata
for URLs -- both assert the heavy step (extract_wav / the real download
call) never ran. One real-network smoke test is gated behind SHORTS_LIVE=1
and skipped otherwise (never run as part of the normal suite).
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from shorts.ffmpeg import run as ffmpeg_run
from shorts.ingest import IngestError, resolve
from shorts.types import MediaInfo

from conftest import FIXTURES_DIR


def _make_clip(tmp_path: Path, duration: float = 1.0) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    clip = tmp_path / "clip.mp4"
    ffmpeg_run([
        "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=320x240:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
        "-c:v", "libx264", "-c:a", "aac", "-shortest",
        str(clip),
    ])
    return clip


_REAL_SUBPROCESS_RUN = subprocess.run


def _fake_yt_dlp(
    calls: list,
    *,
    preflight_stdout: bytes = b"60\nNA\n",
    preflight_returncode: int = 0,
    preflight_stderr: bytes = b"",
    download_returncode: int = 0,
    download_stderr: bytes = b"",
    on_download=None,
):
    """Build a fake subprocess.run that only intercepts yt-dlp invocations
    (args[0] == "yt-dlp") -- ffmpeg/ffprobe calls made by the rest of
    resolve() (probe/extract_wav) fall through to the real subprocess.run
    unmodified. Within the yt-dlp branch, routes by whether "-O" (the
    pre-flight metadata flag) is present, else treats it as the real
    download invocation."""

    def fake_run(args, capture_output=True, check=False):
        if not args or args[0] != "yt-dlp":
            return _REAL_SUBPROCESS_RUN(args, capture_output=capture_output, check=check)
        calls.append(list(args))
        if "-O" in args:
            return subprocess.CompletedProcess(
                args, preflight_returncode, stdout=preflight_stdout, stderr=preflight_stderr
            )
        if on_download is not None:
            on_download(args)
        return subprocess.CompletedProcess(args, download_returncode, stdout=b"", stderr=download_stderr)

    return fake_run


# --- local passthrough (real) ------------------------------------------


def test_resolve_local_file_passthrough(tmp_path):
    clip = _make_clip(tmp_path / "src")

    media = resolve(str(clip), tmp_path / "work")

    assert media.video == clip
    assert media.wav16k.exists()
    assert media.wav16k.stat().st_size > 0
    assert media.info.duration_s > 0


def test_resolve_missing_local_file_raises_unavailable(tmp_path):
    missing = tmp_path / "does_not_exist.mp4"

    with pytest.raises(IngestError) as exc_info:
        resolve(str(missing), tmp_path / "work")

    assert exc_info.value.code == "UNAVAILABLE"
    assert exc_info.value.message


# --- caps: local (mocked probe) -----------------------------------------


def test_local_file_over_duration_cap_raises_too_long_before_wav_extract(tmp_path, monkeypatch):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"stand-in bytes -- probe is mocked, this is never decoded")
    monkeypatch.setattr(
        "shorts.ingest.probe",
        lambda p: MediaInfo(duration_s=3 * 3600 + 1, fps=30.0, width=1920, height=1080),
    )
    extract_calls = []
    monkeypatch.setattr("shorts.ingest.extract_wav", lambda *a, **k: extract_calls.append(a))

    with pytest.raises(IngestError) as exc_info:
        resolve(str(clip), tmp_path / "work")

    assert exc_info.value.code == "TOO_LONG"
    assert extract_calls == []  # caps enforced before the heavy step


def test_local_file_over_size_cap_raises_too_big_before_wav_extract(tmp_path, monkeypatch):
    clip = tmp_path / "clip.mp4"
    clip.touch()
    os.truncate(clip, 2 * 1024**3 + 1)  # sparse file -- no real disk usage
    monkeypatch.setattr(
        "shorts.ingest.probe", lambda p: MediaInfo(duration_s=60.0, fps=30.0, width=1920, height=1080)
    )
    extract_calls = []
    monkeypatch.setattr("shorts.ingest.extract_wav", lambda *a, **k: extract_calls.append(a))

    with pytest.raises(IngestError) as exc_info:
        resolve(str(clip), tmp_path / "work")

    assert exc_info.value.code == "TOO_BIG"
    assert extract_calls == []


# --- caps: URL pre-flight (mocked yt-dlp metadata) ------------------------


def test_url_preflight_over_duration_cap_rejects_before_download(monkeypatch, tmp_path):
    calls = []
    over_cap = 3 * 3600 + 100
    monkeypatch.setattr(
        subprocess, "run", _fake_yt_dlp(calls, preflight_stdout=f"{over_cap}\nNA\n".encode())
    )

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=long", tmp_path)

    assert exc_info.value.code == "TOO_LONG"
    assert len(calls) == 1  # download never invoked


def test_url_preflight_over_size_cap_rejects_before_download(monkeypatch, tmp_path):
    calls = []
    over_cap = 2 * 1024**3 + 1000
    monkeypatch.setattr(
        subprocess, "run", _fake_yt_dlp(calls, preflight_stdout=f"60\n{over_cap}\n".encode())
    )

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=big", tmp_path)

    assert exc_info.value.code == "TOO_BIG"
    assert len(calls) == 1  # download never invoked


def test_url_preflight_missing_filesize_approx_passes_na(monkeypatch, tmp_path):
    """filesize_approx is commonly "NA" for sites/formats that don't report
    it (per task brief) -- missing must not be treated as a cap violation.
    Duration IS present and within cap, so pre-flight should pass and the
    real download call should happen next."""
    calls = []
    real_clip = _make_clip(tmp_path / "realsrc")

    def on_download(args):
        out_idx = args.index("-o")
        dest = Path(args[out_idx + 1].replace("%(ext)s", "mp4"))
        shutil.copy(real_clip, dest)

    monkeypatch.setattr(
        subprocess, "run", _fake_yt_dlp(calls, preflight_stdout=b"60\nNA\n", on_download=on_download)
    )

    media = resolve("https://example.com/watch?v=ok", tmp_path / "work")

    assert len(calls) == 2  # pre-flight, then the real download
    assert media.video.exists()


def test_url_post_download_caps_backstop_over_duration_raises_too_long(monkeypatch, tmp_path):
    """When yt-dlp pre-flight returns "NA" for metadata (passes pre-flight),
    the real download proceeds. The post-download probe() caps check is the
    backstop: if probe() reports over-cap duration, reject before extract_wav."""
    calls = []

    def on_download(args):
        # Create a small dummy file at the expected output path.
        out_idx = args.index("-o")
        dest = Path(args[out_idx + 1].replace("%(ext)s", "mp4"))
        dest.write_bytes(b"dummy video content")

    monkeypatch.setattr(
        subprocess, "run", _fake_yt_dlp(calls, preflight_stdout=b"60\nNA\n", on_download=on_download)
    )
    # Mock probe to report over-cap duration (>3h).
    monkeypatch.setattr(
        "shorts.ingest.probe",
        lambda p: MediaInfo(duration_s=3 * 3600 + 1, fps=30.0, width=1920, height=1080),
    )
    extract_calls = []
    monkeypatch.setattr("shorts.ingest.extract_wav", lambda *a, **k: extract_calls.append(a))

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=longvideo", tmp_path / "work")

    assert exc_info.value.code == "TOO_LONG"
    assert extract_calls == []  # caps enforced before the heavy step


# --- yt-dlp failure -> typed IngestError mapping --------------------------


@pytest.mark.parametrize(
    "stderr_text,expected_code",
    [
        # GeoRestrictedError-style / YouTube-specific wording.
        (b"ERROR: [youtube] abc123: This video is not available in your country", "GEO_BLOCKED"),
        # YouTube age gate.
        (
            b"ERROR: [youtube] abc123: Sign in to confirm your age. "
            b"This video may be inappropriate for some users.",
            "AGE_GATED",
        ),
        # Removed / private / deleted.
        (b"ERROR: [youtube] abc123: Video unavailable. This video has been removed by the uploader", "UNAVAILABLE"),
        # DNS/connect failure surfaced through urllib.
        (
            b"ERROR: [generic] Unable to download webpage: <urlopen error "
            b"[Errno 8] nodename nor servname provided, or not known>",
            "NETWORK",
        ),
        # Unmapped/unknown shape -- falls back to UNAVAILABLE with the tail attached.
        (b"ERROR: some brand new yt-dlp failure mode nobody has mapped yet", "UNAVAILABLE"),
    ],
)
def test_yt_dlp_download_failure_maps_to_typed_code(monkeypatch, tmp_path, stderr_text, expected_code):
    calls = []
    monkeypatch.setattr(
        subprocess, "run", _fake_yt_dlp(calls, download_returncode=1, download_stderr=stderr_text)
    )

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=abc123", tmp_path)

    assert exc_info.value.code == expected_code
    assert exc_info.value.message  # user-readable, non-empty
    assert len(calls) == 2  # pre-flight ran, then the real download attempt


def test_yt_dlp_unmapped_failure_message_includes_stderr_tail(monkeypatch, tmp_path):
    calls = []
    stderr_text = b"ERROR: some brand new yt-dlp failure mode nobody has mapped yet"
    monkeypatch.setattr(
        subprocess, "run", _fake_yt_dlp(calls, download_returncode=1, download_stderr=stderr_text)
    )

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=weird", tmp_path)

    assert "brand new yt-dlp failure mode" in exc_info.value.message


def test_yt_dlp_preflight_failure_maps_error_without_downloading(monkeypatch, tmp_path):
    """The pre-flight metadata fetch hits the same site gates a real
    download would -- a geo/age/removed failure there must map through the
    same classifier, and the real download must never be attempted."""
    calls = []
    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_yt_dlp(
            calls,
            preflight_returncode=1,
            preflight_stderr=b"ERROR: [youtube] xyz: Sign in to confirm your age.",
        ),
    )

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=age", tmp_path)

    assert exc_info.value.code == "AGE_GATED"
    assert len(calls) == 1  # download never invoked


def test_yt_dlp_reports_success_but_writes_no_file_raises_unavailable(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(subprocess, "run", _fake_yt_dlp(calls))  # download "succeeds", writes nothing

    with pytest.raises(IngestError) as exc_info:
        resolve("https://example.com/watch?v=empty", tmp_path / "work")

    assert exc_info.value.code == "UNAVAILABLE"


# --- URL happy path (mocked yt-dlp download) ------------------------------


def test_url_download_success_returns_source_media(monkeypatch, tmp_path):
    real_clip = _make_clip(tmp_path / "realsrc")
    calls = []

    def on_download(args):
        out_idx = args.index("-o")
        dest = Path(args[out_idx + 1].replace("%(ext)s", "mp4"))
        shutil.copy(real_clip, dest)

    monkeypatch.setattr(subprocess, "run", _fake_yt_dlp(calls, on_download=on_download))
    workdir = tmp_path / "work"

    media = resolve("https://example.com/watch?v=ok", workdir)

    assert media.video == workdir / "source.mp4"
    assert media.wav16k.exists()
    assert media.info.duration_s > 0
    assert len(calls) == 2


# --- live network smoke ---------------------------------------------------


@pytest.mark.live
@pytest.mark.skipif(
    os.environ.get("SHORTS_LIVE") != "1",
    reason="requires SHORTS_LIVE=1 (real yt-dlp network download)",
)
def test_live_smoke_downloads_manifest_url(tmp_path):
    """One real yt-dlp download of a T0 fixture-manifest CC source (kept at
    the module's default <=1080p cap rather than forcing an even lower
    quality -- not worth extra plumbing for a smoke test that's skipped by
    default). Confirms resolve()'s full URL path end-to-end: pre-flight,
    download, probe, wav extraction. Never run as part of the normal
    suite/CI -- opt in with SHORTS_LIVE=1."""
    manifest = json.loads((FIXTURES_DIR / "MANIFEST.json").read_text())
    url = manifest["real_podcast_2p.mp4"]["url"]  # 75.0s, tied shortest in MANIFEST

    media = resolve(url, tmp_path)

    assert media.video.exists()
    assert media.wav16k.exists()
    assert media.info.duration_s > 0
