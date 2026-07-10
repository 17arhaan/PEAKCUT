"""Round-trip save/load and query-helper tests for SignalIndex, using a
hand-built index (no real signal extraction needed here)."""

from shorts.signals.index import (
    events_in,
    faces_at,
    load,
    nearest_silence,
    peaks_in,
    save,
    scene_span,
    word_at,
    words_in,
)
from shorts.types import (
    AudioEvent,
    Box,
    Curve,
    FaceFrame,
    MediaInfo,
    Peak,
    SignalIndex,
    Span,
    Word,
)


def _hand_built_index() -> SignalIndex:
    return SignalIndex(
        version=1,
        media=MediaInfo(duration_s=90.0, fps=25.0, width=480, height=270),
        language="en",
        words=[
            Word(text="hello", t0=0.0, t1=0.5, conf=0.95),
            Word(text="world", t0=0.5, t1=1.0, conf=0.9, align_err_ms=12.5),
        ],
        fillers=[Span(t0=0.5, t1=0.6)],
        speech=[Span(t0=0.0, t1=29.4), Span(t0=32.1, t1=90.0)],
        silences=[Span(t0=29.4, t1=32.1)],
        energy=Curve(hop_s=0.05, values=[0.1, 0.2, 0.15]),
        peaks=[Peak(t=60.0, sigma=3.1)],
        rate=Curve(hop_s=0.0, values=[]),
        pitch=Curve(hop_s=0.0, values=[]),
        surges=[],
        monotone=[],
        events=[AudioEvent(label="laughter", t0=45.0, t1=47.0, conf=0.8)],
        scenes=[Span(t0=0.0, t1=20.0), Span(t0=20.0, t1=40.0)],
        faces=[FaceFrame(t=1.0, boxes=[Box(x=0.1, y=0.1, w=0.2, h=0.2, conf=0.99)], dominant=0)],
        motion=Curve(hop_s=0.0, values=[]),
        defects_black=[Span(t0=75.0, t1=76.0)],
        defects_frozen=[],
    )


def test_save_load_round_trip_equal(tmp_path):
    idx = _hand_built_index()
    path = tmp_path / "signals.json"

    save(idx, path)
    loaded = load(path)

    assert loaded == idx


def test_peaks_in():
    idx = _hand_built_index()
    assert peaks_in(idx, 59.0, 61.0) == [Peak(t=60.0, sigma=3.1)]
    assert peaks_in(idx, 0.0, 10.0) == []


def test_nearest_silence():
    idx = _hand_built_index()
    hit = nearest_silence(idx, 30.0)
    assert (hit.t0, hit.t1) == (29.4, 32.1)


def test_word_at():
    idx = _hand_built_index()
    assert word_at(idx, 0.2).text == "hello"
    assert word_at(idx, 5.0) is None


def test_words_in():
    idx = _hand_built_index()
    assert [w.text for w in words_in(idx, 0.0, 1.0)] == ["hello", "world"]
    assert words_in(idx, 2.0, 3.0) == []


def test_faces_at():
    idx = _hand_built_index()
    assert faces_at(idx, 1.2).t == 1.0

    empty = _hand_built_index()
    empty.faces = []
    assert faces_at(empty, 1.0) is None


def test_scene_span():
    idx = _hand_built_index()
    assert scene_span(idx, 25.0) == Span(t0=20.0, t1=40.0)
    assert scene_span(idx, 85.0) is None


def test_events_in():
    idx = _hand_built_index()
    assert events_in(idx, 44.0, 48.0) == [AudioEvent(label="laughter", t0=45.0, t1=47.0, conf=0.8)]
    assert events_in(idx, 44.0, 48.0, label="applause") == []
