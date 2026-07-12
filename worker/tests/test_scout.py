"""Unit tests for the heuristic Scout: hand-built tiny SignalIndex objects,
one rule at a time, plus dedupe/cap/clamp. No real media -- these run
without transcription/ffmpeg, so they're fast and exercise the rule logic
directly (see test_e2e.py for the multi-clip pipeline wiring on a real
fixture)."""

from shorts.agents.scout import MAX_CANDIDATES, heuristic_candidates
from shorts.types import AudioEvent, Curve, MediaInfo, Peak, SignalIndex, Span, Word


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


def _words(n: int, start: float = 0.0, dur: float = 0.4) -> list[Word]:
    return [Word(text=f"w{i}", t0=start + i * dur, t1=start + i * dur + dur, conf=0.9) for i in range(n)]


def test_empty_index_yields_no_candidates():
    idx = _mk_index()
    assert heuristic_candidates(idx) == []


def test_peak_and_surge_within_5s_yields_one_candidate():
    """5-word index with one energy peak and one rate surge 2s apart ->
    exactly one candidate, carrying both signals as evidence."""
    idx = _mk_index(
        words=_words(5, start=8.0),
        peaks=[Peak(t=10.0, sigma=2.5)],
        surges=[Span(t0=12.0, t1=15.0)],
    )

    candidates = heuristic_candidates(idx)

    assert len(candidates) == 1
    c = candidates[0]
    kinds = {claim.kind for claim in c.evidence}
    assert kinds == {"energy_peak", "rate_surge"}
    peak_claim = next(cl for cl in c.evidence if cl.kind == "energy_peak")
    assert peak_claim.value == 2.5
    # window is centered on the peak, +/- 20s, clamped to [0, duration]
    assert c.t0 == 0.0
    assert c.t1 == 30.0


def test_peak_without_nearby_surge_yields_nothing():
    idx = _mk_index(peaks=[Peak(t=10.0, sigma=3.0)], surges=[Span(t0=30.0, t1=33.0)])
    assert heuristic_candidates(idx) == []


def test_laughter_with_enough_leadup_speech_yields_candidate():
    idx = _mk_index(
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
        speech=[Span(t0=30.0, t1=50.0)],
        events=[AudioEvent(label="laughter", t0=50.0, t1=52.0, conf=0.08)],
    )

    candidates = heuristic_candidates(idx)

    assert len(candidates) == 1
    c = candidates[0]
    assert [cl.kind for cl in c.evidence] == ["laughter"]
    assert c.t0 <= 50.0  # opens on the lead-up before the laugh
    assert c.t1 >= 52.0  # includes the laugh itself
    assert c.t1 - c.t0 >= 30.0 - 1e-9  # padded out to the 30s floor


def test_laughter_without_enough_leadup_speech_yields_nothing():
    idx = _mk_index(
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
        speech=[Span(t0=48.0, t1=50.0)],  # only 2s of speech before the event
        events=[AudioEvent(label="laughter", t0=50.0, t1=52.0, conf=0.08)],
    )
    assert heuristic_candidates(idx) == []


def test_applause_counts_same_as_laughter():
    idx = _mk_index(
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
        speech=[Span(t0=30.0, t1=50.0)],
        events=[AudioEvent(label="applause", t0=50.0, t1=53.0, conf=0.6)],
    )
    candidates = heuristic_candidates(idx)
    assert len(candidates) == 1
    assert candidates[0].evidence[0].kind == "applause"


def test_stable_scene_with_top_decile_pitch_variance_yields_candidate():
    # pitch curve at hop_s=1.0 over 100s: mostly low variance (~1.0), one
    # scene span (40..70) is high variance (~100.0) -- top decile of the
    # nonzero population.
    values = [1.0] * 100
    for t in range(40, 70):
        values[t] = 100.0
    idx = _mk_index(
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
        pitch=Curve(hop_s=1.0, values=values),
        scenes=[Span(t0=0.0, t1=40.0), Span(t0=40.0, t1=70.0), Span(t0=70.0, t1=100.0)],
    )

    candidates = heuristic_candidates(idx)

    assert len(candidates) == 1
    c = candidates[0]
    assert c.evidence[0].kind == "scene_stable"
    assert c.t0 == 40.0 and c.t1 == 70.0


def test_stable_scene_below_20s_is_not_a_candidate():
    values = [1.0] * 100
    for t in range(40, 55):
        values[t] = 100.0
    idx = _mk_index(
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
        pitch=Curve(hop_s=1.0, values=values),
        scenes=[Span(t0=40.0, t1=55.0)],  # only 15s, below the 20s floor
    )
    assert heuristic_candidates(idx) == []


def test_dedupe_keeps_higher_evidence_candidate_on_iou_overlap():
    """Two overlapping hits on roughly the same moment (rule a fires twice
    from two close peaks, both landing in near-identical +/-20s windows)
    collapse to one kept candidate -- and if a laughter event lands in the
    same window too, the merge keeps the 2-evidence one over the 1-evidence
    one."""
    idx = _mk_index(
        media=MediaInfo(duration_s=120.0, fps=30.0, width=1920, height=1080),
        speech=[Span(t0=20.0, t1=56.0)],
        peaks=[Peak(t=50.0, sigma=2.2)],
        surges=[Span(t0=51.0, t1=54.0)],
        events=[AudioEvent(label="laughter", t0=56.0, t1=58.0, conf=0.09)],
    )

    candidates = heuristic_candidates(idx)

    # rule (a) window: [30, 70]; rule (b) window: [36, 61] -- IoU > 0.5,
    # so they dedupe to the higher-evidence one (rule a: 2 claims).
    assert len(candidates) == 1
    assert len(candidates[0].evidence) == 2


def test_cap_at_20_candidates():
    duration = 5000.0
    peaks = [Peak(t=100.0 * i, sigma=2.1) for i in range(30)]
    surges = [Span(t0=100.0 * i + 1.0, t1=100.0 * i + 2.0) for i in range(30)]
    idx = _mk_index(
        media=MediaInfo(duration_s=duration, fps=30.0, width=1920, height=1080),
        peaks=peaks,
        surges=surges,
    )

    candidates = heuristic_candidates(idx)

    assert len(candidates) == MAX_CANDIDATES


def test_window_clamped_to_media_duration():
    """A peak near the very start clamps its -20s edge to 0; the remaining
    window is then padded toward the 30s floor (bounded by the 0 edge)."""
    idx = _mk_index(
        media=MediaInfo(duration_s=60.0, fps=30.0, width=1920, height=1080),
        peaks=[Peak(t=2.0, sigma=2.5)],
        surges=[Span(t0=3.0, t1=4.0)],
    )
    candidates = heuristic_candidates(idx)
    assert len(candidates) == 1
    assert candidates[0].t0 == 0.0
    assert candidates[0].t1 == 26.0


def test_long_scene_span_is_split_not_dropped():
    """A scene span far longer than the 90s cap gets split into multiple
    in-bounds candidates rather than truncated/dropped."""
    values = [50.0] * 200
    idx = _mk_index(
        media=MediaInfo(duration_s=200.0, fps=30.0, width=1920, height=1080),
        pitch=Curve(hop_s=1.0, values=values),
        scenes=[Span(t0=0.0, t1=200.0)],
    )

    candidates = heuristic_candidates(idx)

    assert len(candidates) >= 2
    for c in candidates:
        assert 10.0 <= (c.t1 - c.t0) <= 90.0
    total_span = sum(c.t1 - c.t0 for c in candidates)
    assert abs(total_span - 200.0) < 1e-6
