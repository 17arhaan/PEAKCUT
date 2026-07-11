"""Tests for T14 QA repair routing: qa.py's route map, surgeon.repair()'s
deterministic WORD_CLIP/ALIGN fixes on hand-built indexes, and the
pipeline's bounded (max 2) surgeon/render repair loop.

WORD_CLIP/ALIGN repair unit tests use hand-built indexes (same pattern as
test_surgeon.py) -- deterministic, no rendering needed since repair() is
pure Cut/SignalIndex arithmetic. The pipeline-level "permanent failure loops
out and drops" tests monkeypatch qa.check (same pattern as
test_pipeline.py's QA-gate test) so the outcome doesn't depend on what a
real render/re-render actually produces; the real BLACK/ALIGN behavior on
real_talking_head.mp4 (documented in T13's report: 3/4 clips ALIGN-fail
inside the cut, one BLACK failure on genuine source content that no
re-render can fix) is exercised without any mocking at all.
"""

import json
from pathlib import Path

import pytest

from conftest import fixture
from shorts import qa
from shorts.agent_log import AgentLog
from shorts.agents.surgeon import repair
from shorts.pipeline import run
from shorts.types import Curve, Cut, MediaInfo, QAFail, QAReport, SignalIndex, Span, Word


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


# --- route map ---------------------------------------------------------


@pytest.mark.parametrize(
    "code,expected_route",
    [
        ("WORD_CLIP", "surgeon"),
        ("ALIGN", "surgeon"),
        ("LUFS", "render"),
        ("RES", "render"),
        ("BLACK", "render"),
        ("FROZEN", "render"),
        ("DUR", "drop"),
    ],
)
def test_route_map(code, expected_route):
    assert qa._ROUTE[code] == expected_route


# --- surgeon.repair(): WORD_CLIP -----------------------------------------


def test_repair_word_clip_fixes_a_straddled_start_boundary(tmp_path):
    """A word straddles cut.t0 -- one repair() call must re-snap t0 back to
    that word's own start so it's no longer clipped."""
    idx = _mk_index(words=[Word(text="hello", t0=4.5, t1=5.5, conf=0.9)])
    cut = Cut(t0=5.0, t1=13.0)
    failures = [QAFail(code="WORD_CLIP", detail="forced", route_to="surgeon")]

    fixed = repair(cut, idx, failures, _log(tmp_path))

    assert qa._check_word_clip(fixed, idx) is None
    assert fixed.t0 == pytest.approx(4.5)
    assert fixed.t1 == pytest.approx(13.0)  # untouched boundary left alone


def test_repair_word_clip_fixes_a_straddled_end_boundary(tmp_path):
    idx = _mk_index(words=[Word(text="bye", t0=12.5, t1=13.5, conf=0.9)])
    cut = Cut(t0=5.0, t1=13.0)
    failures = [QAFail(code="WORD_CLIP", detail="forced", route_to="surgeon")]

    fixed = repair(cut, idx, failures, _log(tmp_path))

    assert qa._check_word_clip(fixed, idx) is None
    assert fixed.t0 == pytest.approx(5.0)  # untouched boundary left alone
    # _snap_t1 adds up to 0.8s trailing room past the word's own end (13.5),
    # capped only by the media duration bound (60.0s here) -- 14.3, not 13.5.
    assert fixed.t1 == pytest.approx(14.3)


# --- surgeon.repair(): ALIGN ----------------------------------------------


def test_repair_align_trims_to_the_longest_well_aligned_run(tmp_path):
    """20 one-second words: the first 7 (0-7s) are well-aligned, the
    remaining 13 (7-20s) are not. p95 excludes only the single highest
    value in any sample of >=2 (floor(0.95*(n-1)) < n-1 whenever n>=2), so
    a run with exactly ONE bad word mixed in still passes p95<=300 -- the
    actual longest passing run is the 7 good words PLUS the first bad one
    (8 words, [0, 8)); a 9th word (2 bad values) tips p95 over. This
    exercises the same p95 formula qa._check_align uses, so the expected
    boundary is derived from that formula, not eyeballed."""
    words = [Word(text="w", t0=float(i), t1=float(i) + 1.0, conf=0.9, align_err_ms=50.0) for i in range(7)]
    words += [
        Word(text="w", t0=float(i), t1=float(i) + 1.0, conf=0.9, align_err_ms=500.0)
        for i in range(7, 20)
    ]
    idx = _mk_index(language="en", words=words)
    cut = Cut(t0=0.0, t1=20.0)
    failures = [QAFail(code="ALIGN", detail="forced", route_to="surgeon")]

    fixed = repair(cut, idx, failures, _log(tmp_path))

    assert fixed.t0 == pytest.approx(0.0)
    assert fixed.t1 == pytest.approx(8.0)
    assert qa._check_align(fixed, idx) is None
    # and the ORIGINAL cut (all 20 words) genuinely still fails -- the trim
    # is doing real work, not a no-op.
    assert qa._check_align(cut, idx) is not None


def test_repair_align_returns_cut_unchanged_when_no_run_is_well_aligned(tmp_path):
    """Every word is badly aligned -- no contiguous run can ever have
    p95<=300ms, so repair() must give up and return the cut unchanged
    (the pipeline's repair loop then exhausts its budget and drops)."""
    words = [
        Word(text="w", t0=float(i), t1=float(i) + 1.0, conf=0.9, align_err_ms=500.0)
        for i in range(10)
    ]
    idx = _mk_index(language="en", words=words)
    cut = Cut(t0=0.0, t1=10.0)
    failures = [QAFail(code="ALIGN", detail="forced", route_to="surgeon")]

    fixed = repair(cut, idx, failures, _log(tmp_path))

    assert fixed.t0 == pytest.approx(cut.t0)
    assert fixed.t1 == pytest.approx(cut.t1)


def test_repair_align_returns_cut_unchanged_when_the_only_good_run_is_too_short(tmp_path):
    """A 3s well-aligned run exists but falls short of the 5s floor -- must
    not be used, cut stays unchanged."""
    words = [Word(text="w", t0=float(i), t1=float(i) + 1.0, conf=0.9, align_err_ms=50.0) for i in range(3)]
    words += [
        Word(text="w", t0=float(i), t1=float(i) + 1.0, conf=0.9, align_err_ms=500.0)
        for i in range(3, 10)
    ]
    idx = _mk_index(language="en", words=words)
    cut = Cut(t0=0.0, t1=10.0)
    failures = [QAFail(code="ALIGN", detail="forced", route_to="surgeon")]

    fixed = repair(cut, idx, failures, _log(tmp_path))

    assert fixed.t0 == pytest.approx(cut.t0)
    assert fixed.t1 == pytest.approx(cut.t1)


# --- pipeline: bounded repair loop (mocked qa.check) ----------------------


def test_permanent_render_routed_failure_loops_exactly_twice_then_drops(tmp_path, monkeypatch):
    """LUFS is render-routed. Force clip_001 to always fail QA regardless of
    how many times it's re-rendered -- the repair loop must attempt exactly
    2 repairs (not more, not fewer) before giving up and dropping."""
    calls = {"clip_001": 0}

    def fake_check(mp4, cut, idx, hook=None):
        if mp4.parent.name == "clip_001":
            calls["clip_001"] += 1
            return QAReport(
                passed=False, failures=[QAFail(code="LUFS", detail="forced", route_to="render")]
            )
        return QAReport(passed=True, failures=[])

    monkeypatch.setattr(qa, "check", fake_check)

    results = run(fixture("real_talking_head.mp4"), tmp_path)

    clip1 = next(r for r in results if r.mp4.parent.name == "clip_001")
    assert clip1.dropped_reason == "LUFS"
    assert calls["clip_001"] == 3  # 1 initial check + 2 repair-loop re-checks

    run_json = json.loads((tmp_path / "run.json").read_text())
    entry = next(e for e in run_json["clips"] if Path(e["paths"]["mp4"]).parent.name == "clip_001")
    assert len(entry["repairs"]) == 2
    assert [r["attempt"] for r in entry["repairs"]] == [1, 2]
    assert all(r["route"] == "render" and r["outcome"] == "failed" for r in entry["repairs"])


def test_permanent_surgeon_routed_failure_loops_exactly_twice_then_drops(tmp_path, monkeypatch):
    """Same shape as the LUFS test above but for a surgeon-routed code
    (ALIGN) -- covers the "legitimately loops out" case T13 documented as
    a real outcome on this fixture, without depending on which real clip
    happens to fail that way."""
    calls = {"clip_001": 0}

    def fake_check(mp4, cut, idx, hook=None):
        if mp4.parent.name == "clip_001":
            calls["clip_001"] += 1
            return QAReport(
                passed=False, failures=[QAFail(code="ALIGN", detail="forced", route_to="surgeon")]
            )
        return QAReport(passed=True, failures=[])

    monkeypatch.setattr(qa, "check", fake_check)

    results = run(fixture("real_talking_head.mp4"), tmp_path)

    clip1 = next(r for r in results if r.mp4.parent.name == "clip_001")
    assert clip1.dropped_reason == "ALIGN"
    assert calls["clip_001"] == 3

    run_json = json.loads((tmp_path / "run.json").read_text())
    entry = next(e for e in run_json["clips"] if Path(e["paths"]["mp4"]).parent.name == "clip_001")
    assert len(entry["repairs"]) == 2
    assert all(r["route"] == "surgeon" for r in entry["repairs"])


def test_drop_routed_failure_skips_the_repair_loop_entirely(tmp_path, monkeypatch):
    """DUR is drop-routed (unrepairable) -- the clip must drop immediately,
    with zero repair attempts logged, not loop and burn a re-render."""
    calls = {"clip_001": 0}

    def fake_check(mp4, cut, idx, hook=None):
        if mp4.parent.name == "clip_001":
            calls["clip_001"] += 1
            return QAReport(
                passed=False, failures=[QAFail(code="DUR", detail="forced", route_to="drop")]
            )
        return QAReport(passed=True, failures=[])

    monkeypatch.setattr(qa, "check", fake_check)

    results = run(fixture("real_talking_head.mp4"), tmp_path)

    clip1 = next(r for r in results if r.mp4.parent.name == "clip_001")
    assert clip1.dropped_reason == "DUR"
    assert calls["clip_001"] == 1  # only the initial check -- no repair re-checks

    run_json = json.loads((tmp_path / "run.json").read_text())
    entry = next(e for e in run_json["clips"] if Path(e["paths"]["mp4"]).parent.name == "clip_001")
    assert entry["repairs"] == []


# --- real talking-head run: known-reality BLACK/ALIGN outcomes ------------


def test_talking_head_black_from_source_content_cannot_be_repaired_and_drops(tmp_path):
    """No mocking -- the real pipeline against real_talking_head.mp4. T13's
    report documents a genuine BLACK span in the SOURCE video (abs
    27.63-28.09s) that any cut covering it will reproduce on every
    re-render; the repair loop must exhaust its 2-attempt budget and drop
    that clip with BLACK in dropped_reason, not loop forever or silently
    ship a defective clip."""
    results = run(fixture("real_talking_head.mp4"), tmp_path)

    black_dropped = [r for r in results if r.dropped_reason and "BLACK" in r.dropped_reason]
    assert len(black_dropped) == 1

    run_json = json.loads((tmp_path / "run.json").read_text())
    entry = next(
        e for e in run_json["clips"] if e["dropped_reason"] and "BLACK" in e["dropped_reason"]
    )
    # exhausted the full repair budget -- 2 attempts, both still failing.
    assert len(entry["repairs"]) == 2
    assert all(r["outcome"] == "failed" for r in entry["repairs"])
    assert all(r["route"] == "render" for r in entry["repairs"])
