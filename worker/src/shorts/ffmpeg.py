"""Thin subprocess wrappers around the ffmpeg/ffprobe CLIs.

No shell strings, ever -- every invocation is a list of args passed to
`subprocess.run`.
"""

import json
import subprocess
from pathlib import Path

from shorts.types import MediaInfo


class FfmpegError(RuntimeError):
    """Raised when an ffmpeg/ffprobe subprocess exits non-zero."""


def _stderr_tail(stderr: bytes, n: int = 20) -> str:
    lines = stderr.decode("utf-8", errors="replace").splitlines()
    return "\n".join(lines[-n:])


def probe(path: Path) -> MediaInfo:
    """Run ffprobe on `path` and return duration/fps/width/height of its
    first video stream."""
    args = [
        "ffprobe",
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    proc = subprocess.run(args, capture_output=True, check=False)
    if proc.returncode != 0:
        raise FfmpegError(_stderr_tail(proc.stderr))

    data = json.loads(proc.stdout)
    try:
        video_stream = next(s for s in data["streams"] if s["codec_type"] == "video")
    except StopIteration:
        raise FfmpegError(f"no video stream found in {path}") from None

    num, den = video_stream["r_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) else 0.0

    return MediaInfo(
        duration_s=float(data["format"]["duration"]),
        fps=fps,
        width=int(video_stream["width"]),
        height=int(video_stream["height"]),
    )


def run(args: list[str]) -> str:
    """Run ffmpeg with `args` (excluding the leading "ffmpeg" binary name).
    Returns stdout; raises FfmpegError(stderr tail) on nonzero exit."""
    proc = subprocess.run(["ffmpeg", *args], capture_output=True, check=False)
    if proc.returncode != 0:
        raise FfmpegError(_stderr_tail(proc.stderr))
    return proc.stdout.decode("utf-8", errors="replace")


def extract_wav(video: Path, out: Path, sr: int = 16000) -> Path:
    """Extract a mono `sr`Hz PCM wav from `video` into `out`."""
    run([
        "-y",
        "-i", str(video),
        "-vn",
        "-ac", "1",
        "-ar", str(sr),
        str(out),
    ])
    return out
