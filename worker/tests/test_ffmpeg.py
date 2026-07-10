"""ffmpeg.py tests.

ORDER NOTE: Task 0 (fixture factory) runs after this task, so `tests/fixtures/`
does not exist yet -- generate a throwaway clip via ffmpeg lavfi into
`tmp_path` instead of reading a committed fixture.
"""

from pathlib import Path

import pytest

from shorts.ffmpeg import FfmpegError, extract_wav, probe, run


def _make_clip(tmp_path: Path, *, width: int = 320, height: int = 240, rate: int = 30, duration: float = 1.0) -> Path:
    clip = tmp_path / "clip.mp4"
    run([
        "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={rate}:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
        "-c:v", "libx264", "-c:a", "aac", "-shortest",
        str(clip),
    ])
    return clip


def test_probe(tmp_path):
    clip = _make_clip(tmp_path, width=320, height=240, rate=30, duration=1.0)

    info = probe(clip)

    assert info.width == 320
    assert info.height == 240
    assert abs(info.fps - 30.0) < 0.5
    assert 0.9 <= info.duration_s <= 1.1


def test_extract_wav(tmp_path):
    clip = _make_clip(tmp_path, duration=1.0)
    out = tmp_path / "audio.wav"

    result = extract_wav(clip, out, sr=16000)

    assert result == out
    assert out.exists()
    assert out.stat().st_size > 0


def test_run_raises_ffmpeg_error_on_bad_input(tmp_path):
    missing = tmp_path / "does_not_exist.mp4"

    with pytest.raises(FfmpegError):
        run(["-y", "-i", str(missing), str(tmp_path / "out.wav")])


def test_probe_raises_ffmpeg_error_on_bad_input(tmp_path):
    missing = tmp_path / "does_not_exist.mp4"

    with pytest.raises(FfmpegError):
        probe(missing)
