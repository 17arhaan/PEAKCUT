"""Tests for shorts.render.renderer.

The reframe filtergraph shape is checked directly (no ffmpeg/IO). The real-
render tests build a minimal hand-crafted SignalIndex (media probed from the
fixture, no words/faces) rather than running the full signal-extraction
pipeline -- same "hand-built tiny SignalIndex" style as test_scout.py -- to
keep these fast while still exercising real ffmpeg reframe/loudnorm/thumbnail.
"""

import re
import subprocess

from conftest import fixture
from shorts.ffmpeg import probe
from shorts.render.renderer import _reframe_fc, render_clip
from shorts.types import (
    Curve,
    Cut,
    MediaInfo,
    SignalIndex,
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


# --- _reframe_fc: filtergraph shape, no rendering ----------------------


def test_reframe_fc_fills_without_cropping_the_foreground():
    fc = _reframe_fc()
    # both branches fed from the same frame
    assert fc.startswith("[0:v]split=2[bg][fg];")
    # blurred background fills the whole target (increase + crop + blur)
    assert "force_original_aspect_ratio=increase" in fc
    assert "gblur" in fc
    # foreground fits WHOLE -- decrease means nothing is cropped off the source
    assert "force_original_aspect_ratio=decrease" in fc
    # composited centered, and left unlabeled for the caller to chain/append
    assert "overlay=(W-w)/2:(H-h)/2" in fc
    assert not fc.rstrip().endswith("]")


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


def test_render_clip_reframes_landscape_to_1080x1920_no_crash(tmp_path):
    """A 16:9 source (screenshare fixture) reframes to a full 1080x1920 via
    the blurred-fit path -- nothing cropped -- and rendering does not crash."""
    video = fixture("real_screenshare.mp4")
    info = probe(video)
    idx = _mk_index(media=info)
    cut = Cut(t0=1.0, t1=6.0)

    mp4, thumb = render_clip(video, cut, idx, None, "s1", tmp_path / "clip_001")

    assert mp4.exists()
    assert thumb.exists()
    out_info = probe(mp4)
    assert (out_info.width, out_info.height) == (1080, 1920)
    assert 4.5 <= out_info.duration_s <= 5.5


def test_render_clip_captions_are_rebased_to_clip_relative_time(tmp_path):
    """Regression for the caption-timestamp bug: idx.words carry absolute
    source timestamps, but the rendered clip's own timeline starts at 0
    (ffmpeg -ss trim). A cut starting well past 0 (t0=38) must still
    produce karaoke Dialogue lines starting near 0, not near 38 -- the
    latter would place captions after the clip has already ended."""
    video = fixture("real_talking_head.mp4")
    info = probe(video)
    idx = _mk_index(
        media=info,
        words=[
            Word(text="hello", t0=38.5, t1=38.8, conf=0.9),
            Word(text="world", t0=39.0, t1=39.3, conf=0.9),
            Word(text="this", t0=39.4, t1=39.6, conf=0.9),
        ],
    )
    cut = Cut(t0=38.0, t1=50.0)

    mp4, _thumb = render_clip(video, cut, idx, None, "s1", tmp_path / "clip_001")

    clip_duration = cut.t1 - cut.t0
    ass_text = (tmp_path / "clip_001" / "clip.ass").read_text()
    starts = [
        float(m.group(1)) * 3600 + float(m.group(2)) * 60 + float(m.group(3))
        for m in re.finditer(
            r"Dialogue: 0,(\d+):(\d\d):(\d\d\.\d\d),.*?,s1,", ass_text
        )
    ]
    assert starts, f"no s1 Dialogue lines found in:\n{ass_text}"
    for start in starts:
        assert 0.0 <= start <= clip_duration, (
            f"Dialogue start {start}s outside clip bounds [0, {clip_duration}]"
        )
    assert mp4.exists()


def test_render_clip_loudness_is_normalized_to_minus_14_lufs(tmp_path):
    video = fixture("real_talking_head.mp4")
    info = probe(video)
    idx = _mk_index(media=info, words=[Word(text="hi", t0=5.1, t1=5.3, conf=0.9)])
    cut = Cut(t0=5.0, t1=13.0)

    mp4, _thumb = render_clip(video, cut, idx, None, "s1", tmp_path / "clip_001")

    lufs = _lufs(mp4)
    assert -15.0 <= lufs <= -13.0, f"measured {lufs} LUFS, want -14 +/- 1"
