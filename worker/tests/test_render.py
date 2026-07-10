"""Tests for shorts.render.renderer.

Pure crop-geometry math is tested directly (no ffmpeg/IO). The two real-
render tests build a minimal hand-crafted SignalIndex (media probed from the
fixture, no words/faces) rather than running the full signal-extraction
pipeline -- same "hand-built tiny SignalIndex" style as test_scout.py -- to
keep these fast while still exercising real ffmpeg crop/loudnorm/thumbnail.
"""

import re
import subprocess

from conftest import fixture
from shorts.ffmpeg import probe
from shorts.render.renderer import _crop_geometry, _scene_face_center_x, render_clip
from shorts.types import (
    Box,
    Curve,
    Cut,
    FaceFrame,
    MediaInfo,
    SignalIndex,
    Span,
    Word,
)


def _mk_index(**overrides) -> SignalIndex:
    defaults = dict(
        version=1,
        media=MediaInfo(duration_s=60.0, fps=30.0, width=1920, height=1080),
        language="en",
        words=[],
        fillers=[],
        speech=[],
        silences=[],
        energy=Curve(hop_s=0.05, values=[]),
        peaks=[],
        rate=Curve(hop_s=1.0, values=[]),
        pitch=Curve(hop_s=1.0, values=[]),
        surges=[],
        monotone=[],
        events=[],
        scenes=[],
        faces=[],
        motion=Curve(hop_s=0.5, values=[]),
        defects_black=[],
        defects_frozen=[],
    )
    defaults.update(overrides)
    return SignalIndex(**defaults)


# --- _crop_geometry: pure function, no rendering -----------------------


def test_crop_geometry_no_face_centers():
    assert _crop_geometry(1920, 1080, None) == (607, 1080, 656, 0)


def test_crop_geometry_dominant_face_shifts_crop_window():
    left = _crop_geometry(1920, 1080, 0.1)
    center = _crop_geometry(1920, 1080, 0.5)
    right = _crop_geometry(1920, 1080, 0.9)
    assert left[2] < center[2] < right[2]


def test_crop_geometry_clamps_to_frame_at_edges():
    crop_w, _crop_h, x, _y = _crop_geometry(1920, 1080, 0.0)
    assert x == 0
    crop_w, _crop_h, x, _y = _crop_geometry(1920, 1080, 1.0)
    assert x == 1920 - crop_w


def test_crop_geometry_portrait_input_skips_crop():
    """Source already <=9:16 (portrait-or-narrower) -> None means "scale
    +pad, don't crop" (per the crop fallback chain)."""
    assert _crop_geometry(1080, 1920, None) is None
    assert _crop_geometry(1080, 1920, 0.5) is None
    assert _crop_geometry(900, 1600, None) is None  # narrower than 9:16 too


def test_crop_geometry_exact_9x16_skips_crop():
    assert _crop_geometry(720, 1280, None) is None


# --- _scene_face_center_x -----------------------------------------------


def test_scene_face_center_x_none_when_no_dominant_faces():
    idx = _mk_index(faces=[FaceFrame(t=1.0, boxes=[], dominant=None)])
    assert _scene_face_center_x(idx, Cut(t0=0.0, t1=5.0)) is None


def test_scene_face_center_x_averages_dominant_centers_in_scene_span():
    idx = _mk_index(
        scenes=[Span(t0=0.0, t1=10.0)],
        faces=[
            FaceFrame(t=1.0, boxes=[Box(x=0.0, y=0.0, w=0.2, h=0.2, conf=0.9)], dominant=0),
            FaceFrame(t=2.0, boxes=[Box(x=0.2, y=0.0, w=0.2, h=0.2, conf=0.9)], dominant=0),
        ],
    )
    # centers: 0.0+0.1=0.1, 0.2+0.1=0.3 -> mean 0.2
    assert abs(_scene_face_center_x(idx, Cut(t0=0.0, t1=10.0)) - 0.2) < 1e-9


# --- real renders --------------------------------------------------------


def _lufs(mp4) -> float:
    proc = subprocess.run(
        ["ffmpeg", "-i", str(mp4), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True, check=False,
    )
    stderr = proc.stderr.decode("utf-8", errors="replace")
    summary = stderr.rsplit("Summary:", 1)[-1]
    match = re.search(r"I:\s*(-?[\d.]+) LUFS", summary)
    assert match, f"no Integrated loudness line found:\n{stderr[-1000:]}"
    return float(match.group(1))


def test_render_clip_on_screenshare_no_faces_center_crop_no_crash(tmp_path):
    """real_screenshare.mp4 has no dominant faces (screenshare) -- crop
    should fall back to center crop and rendering should not crash."""
    video = fixture("real_screenshare.mp4")
    info = probe(video)
    idx = _mk_index(media=info, faces=[FaceFrame(t=t, boxes=[], dominant=None) for t in range(6)])
    cut = Cut(t0=1.0, t1=6.0)

    mp4, thumb = render_clip(video, cut, idx, None, "s1", tmp_path / "clip_001")

    assert mp4.exists()
    assert thumb.exists()
    out_info = probe(mp4)
    assert (out_info.width, out_info.height) == (1080, 1920)
    assert 4.5 <= out_info.duration_s <= 5.5

    expected_crop_w = (info.height * 9) // 16
    expected_x = (info.width - expected_crop_w) // 2
    assert _crop_geometry(info.width, info.height, None) == (expected_crop_w, info.height, expected_x, 0)


def test_render_clip_loudness_is_normalized_to_minus_14_lufs(tmp_path):
    video = fixture("real_talking_head.mp4")
    info = probe(video)
    idx = _mk_index(media=info, words=[Word(text="hi", t0=5.1, t1=5.3, conf=0.9)])
    cut = Cut(t0=5.0, t1=13.0)

    mp4, _thumb = render_clip(video, cut, idx, None, "s1", tmp_path / "clip_001")

    lufs = _lufs(mp4)
    assert -15.0 <= lufs <= -13.0, f"measured {lufs} LUFS, want -14 +/- 1"
