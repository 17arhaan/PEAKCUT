"""Tests for shorts.qa: the pure-code QA gate that inspects rendered clips
before they ship. NO LLM anywhere here -- every check is ffmpeg/ffprobe
output parsing or SignalIndex arithmetic.

RES/LUFS/BLACK/FROZEN need a real rendered clip to corrupt (ffprobe/ebur128/
blackdetect all read real media), so those are exercised as integration
tests against corrupted copies of one real T7 render -- built ONCE per test
session (module-scoped fixtures) to keep total runtime sane, rather than
re-rendering per test. WORD_CLIP/ALIGN/DUR are pure arithmetic over a
Cut+SignalIndex and need no media at all, so those are plain unit tests
against the private per-check helpers.
"""

import subprocess

import pytest

from conftest import fixture
from shorts.ffmpeg import probe
from shorts.qa import _check_align, _check_dur, _check_word_clip, check
from shorts.render.renderer import render_clip
from shorts.types import Curve, Cut, MediaInfo, SignalIndex, Word


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


# --- integration: real renders + ffmpeg-corrupted copies ----------------

_CUT = Cut(t0=5.0, t1=13.0)  # 8s, matches clean_clip's render window below


def _clean_idx() -> SignalIndex:
    """A source-timeline index whose one word sits fully inside _CUT with a
    small align_err_ms -- passes WORD_CLIP and ALIGN so the render-corruption
    tests below isolate exactly the corruption under test."""
    return _mk_index(
        language="en",
        words=[Word(text="hi", t0=5.1, t1=5.3, conf=0.9, align_err_ms=50.0)],
    )


@pytest.fixture(scope="module")
def clean_clip(tmp_path_factory):
    """One real T7 render (real_talking_head.mp4, 5.0-13.0s) -- the clean
    baseline every corrupted variant below is derived from via ffmpeg,
    rather than re-rendering per corruption."""
    out_dir = tmp_path_factory.mktemp("qa_clean")
    video = fixture("real_talking_head.mp4")
    info = probe(video)
    idx = _mk_index(media=info, words=[Word(text="hi", t0=5.1, t1=5.3, conf=0.9)])
    mp4, _thumb = render_clip(video, _CUT, idx, None, "s1", out_dir / "clip_001")
    return mp4


@pytest.fixture(scope="module")
def res_corrupt_clip(tmp_path_factory, clean_clip):
    """Wrong-scale re-encode (640x480, not 1080x1920). Video re-encoded,
    audio stream-copied -- LUFS/DUR untouched, isolating RES."""
    out = tmp_path_factory.mktemp("qa_res") / "res_corrupt.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(clean_clip), "-vf", "scale=640:480", "-c:a", "copy", str(out)],
        capture_output=True, check=True,
    )
    return out


@pytest.fixture(scope="module")
def lufs_corrupt_clip(tmp_path_factory, clean_clip):
    """+8dB volume re-encode. Audio re-encoded, video stream-copied --
    RES/BLACK/FROZEN/DUR untouched, isolating LUFS."""
    out = tmp_path_factory.mktemp("qa_lufs") / "lufs_corrupt.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(clean_clip), "-c:v", "copy", "-af", "volume=+8dB", str(out)],
        capture_output=True, check=True,
    )
    return out


@pytest.fixture(scope="module")
def black_corrupt_clip(tmp_path_factory, clean_clip):
    """1s of solid black drawn over the frame partway through the clip.
    Video must be re-encoded (drawbox can't be stream-copied); audio is
    stream-copied so LUFS stays untouched.

    NOTE: a full-frame static black box held for >=0.5s also trips
    freezedetect's stillness threshold -- the same coincidence already
    documented for the synth_av fixture in test_signals_video.py
    (test_detect_defects_frozen_flags_the_held_black_frame). BLACK and
    FROZEN co-firing here is expected, not a bug -- the test below asserts
    BLACK is IN failures (plus the allowed FROZEN co-failure), not
    failures == [BLACK]."""
    out = tmp_path_factory.mktemp("qa_black") / "black_corrupt.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(clean_clip),
            "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,2,3)'",
            "-c:a", "copy",
            str(out),
        ],
        capture_output=True, check=True,
    )
    return out


def test_qa_clean_render_passes_all_checks(clean_clip):
    report = check(clean_clip, _CUT, _clean_idx())
    assert report.passed
    assert report.failures == []


def test_qa_res_corrupt_fails_res_only(res_corrupt_clip):
    report = check(res_corrupt_clip, _CUT, _clean_idx())
    assert [f.code for f in report.failures] == ["RES"]
    assert not report.passed


def test_qa_lufs_corrupt_fails_lufs_only(lufs_corrupt_clip):
    report = check(lufs_corrupt_clip, _CUT, _clean_idx())
    assert [f.code for f in report.failures] == ["LUFS"]
    assert not report.passed


def test_qa_black_corrupt_fails_black(black_corrupt_clip):
    report = check(black_corrupt_clip, _CUT, _clean_idx())
    codes = {f.code for f in report.failures}
    assert "BLACK" in codes
    assert codes <= {"BLACK", "FROZEN"}  # FROZEN is an allowed co-failure, see fixture note
    assert not report.passed


def test_qa_failures_route_to_drop(res_corrupt_clip):
    report = check(res_corrupt_clip, _CUT, _clean_idx())
    assert all(f.route_to == "drop" for f in report.failures)


# --- pure unit tests: WORD_CLIP / ALIGN / DUR, no rendering --------------


def test_check_dur_too_short():
    assert _check_dur(4.9).code == "DUR"


def test_check_dur_too_long():
    assert _check_dur(90.1).code == "DUR"


def test_check_dur_within_bounds_passes():
    assert _check_dur(30.0) is None


def test_check_word_clip_straddles_start_boundary():
    idx = _mk_index(words=[Word(text="hello", t0=4.5, t1=5.5, conf=0.9)])
    fail = _check_word_clip(Cut(t0=5.0, t1=13.0), idx)
    assert fail is not None and fail.code == "WORD_CLIP"


def test_check_word_clip_straddles_end_boundary():
    idx = _mk_index(words=[Word(text="hello", t0=12.5, t1=13.5, conf=0.9)])
    fail = _check_word_clip(Cut(t0=5.0, t1=13.0), idx)
    assert fail is not None and fail.code == "WORD_CLIP"


def test_check_word_clip_word_fully_inside_cut_passes():
    idx = _mk_index(words=[Word(text="hello", t0=6.0, t1=6.5, conf=0.9)])
    assert _check_word_clip(Cut(t0=5.0, t1=13.0), idx) is None


def test_check_word_clip_word_fully_outside_cut_passes():
    idx = _mk_index(words=[Word(text="hello", t0=20.0, t1=20.5, conf=0.9)])
    assert _check_word_clip(Cut(t0=5.0, t1=13.0), idx) is None


def test_check_align_p95_over_threshold_fails():
    words = [
        Word(text="w", t0=float(i), t1=float(i) + 0.5, conf=0.9, align_err_ms=err)
        for i, err in enumerate([50.0] * 18 + [400.0, 500.0])
    ]
    idx = _mk_index(language="en", words=words)
    fail = _check_align(Cut(t0=0.0, t1=20.0), idx)
    assert fail is not None and fail.code == "ALIGN"


def test_check_align_p95_under_threshold_passes():
    words = [
        Word(text="w", t0=float(i), t1=float(i) + 0.5, conf=0.9, align_err_ms=50.0)
        for i in range(20)
    ]
    idx = _mk_index(language="en", words=words)
    assert _check_align(Cut(t0=0.0, t1=20.0), idx) is None


def test_check_align_skips_words_with_none_err():
    idx = _mk_index(
        language="en", words=[Word(text="w", t0=0.0, t1=0.5, conf=0.9, align_err_ms=None)]
    )
    assert _check_align(Cut(t0=0.0, t1=1.0), idx) is None


def test_check_align_skips_non_english():
    """PLAN AMENDMENT (align.py, decision 2026-07-11): ALIGN threshold is
    300ms p95, and the check is skipped entirely for non-"en" language --
    these words would fail if language were "en"."""
    words = [
        Word(text="w", t0=float(i), t1=float(i) + 0.5, conf=0.9, align_err_ms=500.0)
        for i in range(20)
    ]
    idx = _mk_index(language="es", words=words)
    assert _check_align(Cut(t0=0.0, t1=20.0), idx) is None
