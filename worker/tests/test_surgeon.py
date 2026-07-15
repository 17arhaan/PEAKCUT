"""Tests for shorts.agents.surgeon: deterministic cut refinement.

Property-style tests run against the REAL fixture index (synth_av.mp4,
built once via build_signal_index -- module-scoped, same pattern as
test_evidence.py) over every candidate Scout actually produces for it, since
that's the population surgeon.refine has to hold up against in the real
pipeline. Targeted unit tests below that use hand-built indexes to pin down
individual rules (silence-vs-word-start priority, filler stripping,
trailing-room cap, payoff detection, LLM tie-break) precisely.
"""

import pytest

from conftest import fixture
from shorts.agent_log import AgentLog
from shorts.agents.scout import fallback_candidates, heuristic_candidates
from shorts.agents.surgeon import (
    _payoff_word_i,
    _snap_t0,
    _snap_t1,
    _strip_leading_fillers,
    refine,
)
from shorts.ffmpeg import extract_wav, probe
from shorts.qa import _check_word_clip
from shorts.signals.index import build_signal_index, words_in
from shorts.types import (
    Candidate,
    Claim,
    Curve,
    MediaInfo,
    SignalIndex,
    SourceMedia,
    Span,
    Word,
)

_TOL = 1e-6


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


def _log(tmp_path) -> AgentLog:
    return AgentLog(tmp_path / "agent_events.jsonl")


# --- property tests over the real fixture index --------------------------


@pytest.fixture(scope="module")
def real_idx(tmp_path_factory):
    workdir = tmp_path_factory.mktemp("surgeon_signals")
    video = fixture("synth_av.mp4")
    wav = extract_wav(video, workdir / "audio.wav")
    media = SourceMedia(video=video, wav16k=wav, info=probe(video))
    return build_signal_index(media, workdir)


@pytest.fixture(scope="module")
def real_candidates(real_idx):
    cands = heuristic_candidates(real_idx) + fallback_candidates(real_idx, 4)
    assert cands  # the fixture must actually give us something to refine
    return cands


def test_refined_cuts_open_on_a_silence_edge_or_word_start(real_idx, real_candidates, tmp_path):
    log = _log(tmp_path)
    silence_edges = [s.t1 for s in real_idx.silences]
    word_starts = [w.t0 for w in real_idx.words]

    for cand in real_candidates:
        cut = refine(cand, real_idx, log)
        on_silence = any(abs(cut.t0 - t) <= _TOL for t in silence_edges)
        on_word_start = any(abs(cut.t0 - t) <= _TOL for t in word_starts)
        assert on_silence or on_word_start, f"t0={cut.t0} matches neither a silence edge nor a word start"


def test_refined_cuts_never_straddle_a_word_at_either_boundary(real_idx, real_candidates, tmp_path):
    log = _log(tmp_path)
    for cand in real_candidates:
        cut = refine(cand, real_idx, log)
        assert _check_word_clip(cut, real_idx) is None


def test_refined_cuts_have_no_leading_filler(real_idx, real_candidates, tmp_path):
    log = _log(tmp_path)
    for cand in real_candidates:
        cut = refine(cand, real_idx, log)
        window = words_in(real_idx, cut.t0, cut.t1)
        if not window:
            continue
        first = min(window, key=lambda w: w.t0)
        assert not any(s.t0 <= first.t0 and first.t1 <= s.t1 for s in real_idx.fillers)


def test_refined_cuts_duration_within_bounds(real_idx, real_candidates, tmp_path):
    log = _log(tmp_path)
    for cand in real_candidates:
        cut = refine(cand, real_idx, log)
        assert 5.0 <= cut.t1 - cut.t0 <= 90.0


# --- targeted unit tests: silence-vs-word-start snap priority ------------


def test_snap_t0_prefers_silence_over_word_start_when_not_ambiguous(tmp_path):
    idx = _mk_index(
        silences=[Span(t0=8.0, t1=9.0)],
        words=[Word(text="hi", t0=3.0, t1=3.5, conf=0.9)],
    )
    cand = Candidate(t0=12.0, t1=20.0, source="test", evidence=[])
    assert _snap_t0(cand, idx, _log(tmp_path)) == pytest.approx(9.0)


def test_snap_t0_falls_back_to_word_start_when_no_silence_in_range(tmp_path):
    idx = _mk_index(
        silences=[Span(t0=1.0, t1=1.4)],  # 10.6s away -- past the 5s search-back bound
        words=[Word(text="hi", t0=3.0, t1=3.5, conf=0.9), Word(text="there", t0=7.0, t1=7.4, conf=0.9)],
    )
    cand = Candidate(t0=12.0, t1=20.0, source="test", evidence=[])
    assert _snap_t0(cand, idx, _log(tmp_path)) == pytest.approx(7.0)


def test_snap_t0_disqualifies_silence_edge_that_lands_mid_word(tmp_path):
    """Real audio: VAD-detected silence and forced-alignment word timestamps
    can disagree (a silence span ending inside a word's measured span) --
    that silence edge must be disqualified as a t0 target, not trusted,
    since it would violate the "never open mid-word" invariant."""
    idx = _mk_index(
        silences=[Span(t0=17.4, t1=18.4)],
        words=[
            Word(text="hi", t0=15.0, t1=15.5, conf=0.9),
            Word(text="the", t0=18.3, t1=18.5, conf=0.9),  # straddles the silence edge at 18.4
        ],
    )
    cand = Candidate(t0=19.9, t1=30.0, source="test", evidence=[])
    t0 = _snap_t0(cand, idx, _log(tmp_path))
    assert t0 == pytest.approx(18.3)  # falls back to the word-start rule ("the"'s own t0)
    assert not any(w.t0 < t0 < w.t1 for w in idx.words)


def test_snap_t0_ignores_too_short_silence(tmp_path):
    idx = _mk_index(
        silences=[Span(t0=8.0, t1=8.2)],  # 0.2s -- below the 0.3s minimum
        words=[Word(text="hi", t0=3.0, t1=3.5, conf=0.9)],
    )
    cand = Candidate(t0=12.0, t1=20.0, source="test", evidence=[])
    assert _snap_t0(cand, idx, _log(tmp_path)) == pytest.approx(3.0)


# --- filler stripping -----------------------------------------------------


def test_strip_leading_fillers_advances_past_filler_word():
    idx = _mk_index(
        words=[Word(text="um", t0=5.0, t1=5.3, conf=0.8), Word(text="hello", t0=5.3, t1=5.8, conf=0.9)],
        fillers=[Span(t0=5.0, t1=5.3)],
    )
    assert _strip_leading_fillers(5.0, idx) == pytest.approx(5.3)


def test_strip_leading_fillers_noop_when_first_word_is_not_a_filler():
    idx = _mk_index(words=[Word(text="hello", t0=5.0, t1=5.5, conf=0.9)], fillers=[])
    assert _strip_leading_fillers(5.0, idx) == pytest.approx(5.0)


def test_strip_leading_fillers_advances_past_multiple_leading_fillers():
    idx = _mk_index(
        words=[
            Word(text="um", t0=5.0, t1=5.3, conf=0.8),
            Word(text="uh", t0=5.3, t1=5.6, conf=0.8),
            Word(text="hello", t0=5.6, t1=6.0, conf=0.9),
        ],
        fillers=[Span(t0=5.0, t1=5.3), Span(t0=5.3, t1=5.6)],
    )
    assert _strip_leading_fillers(5.0, idx) == pytest.approx(5.6)


# --- t1 snap / trailing room ----------------------------------------------


def test_snap_t1_trailing_room_capped_at_0_8_when_gap_is_large():
    idx = _mk_index(words=[Word(text="hi", t0=10.0, t1=10.5, conf=0.9), Word(text="bye", t0=20.0, t1=20.5, conf=0.9)])
    cand = Candidate(t0=5.0, t1=10.2, source="test", evidence=[])
    assert _snap_t1(cand, idx) == pytest.approx(11.3)


def test_snap_t1_trailing_room_capped_by_next_word_gap_when_smaller():
    idx = _mk_index(
        words=[Word(text="hi", t0=10.0, t1=10.5, conf=0.9), Word(text="bye", t0=10.7, t1=11.0, conf=0.9)]
    )
    cand = Candidate(t0=5.0, t1=10.2, source="test", evidence=[])
    assert _snap_t1(cand, idx) == pytest.approx(10.7)


# --- sentence-aware boundaries (punctuation-driven) ------------------------


def test_snap_t1_extends_to_the_end_of_the_payoff_sentence():
    """A raw t1 landing mid-sentence extends to the end of that sentence
    (word ending in .!?), so the payoff isn't clipped."""
    idx = _mk_index(words=[
        Word(text="Here's", t0=10.0, t1=10.3, conf=0.9),
        Word(text="the", t0=10.3, t1=10.5, conf=0.9),
        Word(text="setup.", t0=10.5, t1=11.0, conf=0.9),
        Word(text="And", t0=11.2, t1=11.4, conf=0.9),
        Word(text="the", t0=11.4, t1=11.6, conf=0.9),
        Word(text="punchline!", t0=11.6, t1=12.4, conf=0.9),
        Word(text="Next", t0=13.4, t1=13.7, conf=0.9),
    ])
    cand = Candidate(t0=10.0, t1=11.5, source="test", evidence=[])  # raw t1 mid-sentence
    t1 = _snap_t1(cand, idx)
    assert t1 >= 12.4  # reached the end of "punchline!"
    assert t1 <= 13.4  # didn't run into the next sentence


def test_snap_t0_opens_on_the_sentence_start(tmp_path):
    """A raw t0 landing mid-sentence moves back to that sentence's first word."""
    idx = _mk_index(words=[
        Word(text="Earlier.", t0=5.0, t1=5.6, conf=0.9),
        Word(text="So", t0=7.0, t1=7.2, conf=0.9),
        Word(text="anyway,", t0=7.2, t1=7.6, conf=0.9),
        Word(text="the", t0=7.6, t1=7.8, conf=0.9),
        Word(text="story", t0=7.8, t1=8.2, conf=0.9),
    ])
    cand = Candidate(t0=7.7, t1=40.0, source="test", evidence=[])  # raw t0 mid-sentence
    assert _snap_t0(cand, idx, _log(tmp_path)) == pytest.approx(7.0)


def test_snap_t1_falls_back_when_no_sentence_ends_within_reach():
    """No sentence-ending punctuation near the raw t1 -> keep the old word-end
    behavior instead of reaching arbitrarily far."""
    idx = _mk_index(words=[
        Word(text="one", t0=10.0, t1=10.4, conf=0.9),
        Word(text="two", t0=10.4, t1=10.8, conf=0.9),
        Word(text="three", t0=30.0, t1=30.5, conf=0.9),  # only period-free words
    ])
    cand = Candidate(t0=5.0, t1=10.5, source="test", evidence=[])
    # word-end fallback: nearest end >=10.5 is "two"(10.8) + 0.8 trailing = 11.6
    assert _snap_t1(cand, idx) == pytest.approx(11.6)


# --- payoff_word_i ---------------------------------------------------------


def test_payoff_word_i_uses_strongest_energy_peak_claim():
    idx = _mk_index(
        words=[
            Word(text="a", t0=0.0, t1=1.0, conf=0.9),
            Word(text="b", t0=1.0, t1=2.0, conf=0.9),
            Word(text="c", t0=2.0, t1=3.0, conf=0.9),
            Word(text="d", t0=3.0, t1=4.0, conf=0.9),
        ]
    )
    cand = Candidate(
        t0=0.0, t1=4.0, source="test",
        evidence=[
            Claim(kind="energy_peak", t=1.5, value=1.0),
            Claim(kind="energy_peak", t=3.5, value=-3.0),  # larger magnitude, negative
        ],
    )
    assert _payoff_word_i(cand, idx) == 3


def test_payoff_word_i_falls_back_to_first_claim_for_non_energy_evidence():
    idx = _mk_index(
        words=[
            Word(text="a", t0=0.0, t1=1.0, conf=0.9),
            Word(text="b", t0=1.0, t1=2.0, conf=0.9),
            Word(text="c", t0=2.0, t1=3.0, conf=0.9),
        ]
    )
    cand = Candidate(
        t0=0.0, t1=3.0, source="test",
        evidence=[Claim(kind="quote", t=1.5, value="hello"), Claim(kind="quote", t=2.5, value="world")],
    )
    assert _payoff_word_i(cand, idx) == 1


def test_payoff_word_i_none_for_no_evidence_candidate():
    idx = _mk_index(words=[Word(text="a", t0=0.0, t1=1.0, conf=0.9)])
    cand = Candidate(t0=0.0, t1=1.0, source="fallback", evidence=[])
    assert _payoff_word_i(cand, idx) is None


# --- LLM tie-break ----------------------------------------------------------


def _ambiguous_idx():
    """silence edge at 9.0, word start at 10.0 -- 1s apart, inside the 2s
    ambiguity window; both within the 5s silence search-back of t0=12.0."""
    return _mk_index(
        silences=[Span(t0=8.5, t1=9.0)],
        words=[Word(text="hi", t0=10.0, t1=10.4, conf=0.9)],
    )


def test_tie_break_invoked_when_targets_are_within_ambiguity_window(tmp_path, monkeypatch):
    idx = _ambiguous_idx()
    cand = Candidate(t0=12.0, t1=20.0, source="test", evidence=[])
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        return {"choice": 9.0}

    monkeypatch.setattr("shorts.agents.surgeon.complete_json", fake_complete_json)

    result = _snap_t0(cand, idx, _log(tmp_path))

    assert len(calls) == 1
    assert "9.000" in calls[0] and "10.000" in calls[0]
    assert result == pytest.approx(9.0)


def test_tie_break_not_invoked_outside_ambiguity_window(tmp_path, monkeypatch):
    idx = _mk_index(
        silences=[Span(t0=8.0, t1=9.0)],
        words=[Word(text="hi", t0=3.0, t1=3.5, conf=0.9)],  # 5.5s from the silence target
    )
    cand = Candidate(t0=12.0, t1=20.0, source="test", evidence=[])

    def fail_if_called(*args, **kwargs):
        raise AssertionError("complete_json should not be called outside the ambiguity window")

    monkeypatch.setattr("shorts.agents.surgeon.complete_json", fail_if_called)

    assert _snap_t0(cand, idx, _log(tmp_path)) == pytest.approx(9.0)


def test_tie_break_stub_mode_falls_back_to_earlier_target(tmp_path, monkeypatch):
    """No monkeypatch -- SHORTS_LLM defaults to stub, so complete_json raises
    StubModeError and the deterministic fallback (the earlier target) wins."""
    monkeypatch.delenv("SHORTS_LLM", raising=False)
    idx = _ambiguous_idx()
    cand = Candidate(t0=12.0, t1=20.0, source="test", evidence=[])

    assert _snap_t0(cand, idx, _log(tmp_path)) == pytest.approx(9.0)  # min(9.0, 10.0)


# --- refine() clamping ------------------------------------------------------


def test_refine_clamps_duration_to_media_bounds(tmp_path):
    """A candidate near the very end of a short media file: snapping alone
    would produce a sub-30s cut, so the duration floor extends it -- but
    never past media.duration_s."""
    idx = _mk_index(
        media=MediaInfo(duration_s=10.0, fps=30.0, width=1920, height=1080),
        words=[Word(text="hi", t0=8.0, t1=8.5, conf=0.9)],
    )
    cand = Candidate(t0=8.0, t1=8.6, source="test", evidence=[])
    cut = refine(cand, idx, _log(tmp_path))
    assert cut.t1 <= idx.media.duration_s
    assert cut.t0 >= 0.0


def test_duration_floor_widening_reopens_on_a_word_start(tmp_path):
    """The _MIN_DUR_S floor widens a too-short cut by arithmetic
    (t0 = t1 - 30); the reopened t0 must land on a word start / silence edge,
    not mid-word (the exact CI failure: t0=60.0 on a 90s source with no word
    boundary there)."""
    # words every 0.7s from 55s to 90s; none starts at exactly 60.0
    words = [
        Word(text=f"w{i}", t0=55.3 + i * 0.7, t1=55.3 + i * 0.7 + 0.5, conf=0.9)
        for i in range(50)
    ]
    idx = _mk_index(
        media=MediaInfo(duration_s=90.0, fps=30.0, width=1920, height=1080),
        words=[w for w in words if w.t1 <= 90.0],
    )
    # candidate snaps inside [85, 90) -> ~5s long -> floor widens toward t1-30
    cand = Candidate(t0=85.0, t1=89.9, source="rule", evidence=[])

    cut = refine(cand, idx, _log(tmp_path))

    assert cut.t1 - cut.t0 >= 30.0 - 1e-6
    word_starts = [w.t0 for w in idx.words]
    assert any(abs(cut.t0 - t) <= _TOL for t in word_starts), (
        f"t0={cut.t0} is arithmetic, not a word start"
    )
