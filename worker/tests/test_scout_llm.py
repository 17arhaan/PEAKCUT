"""Tests for Scout's LLM semantic pass. Monkeypatch complete_json itself
(NOT the Anthropic SDK -- that's test_llm.py's job) since these exercise
Scout's own re-ask/evidence-gate/dedupe logic on top of it.
"""

import json

import pytest

from shorts.agent_log import AgentLog
from shorts.agents.scout import _llm_candidates, candidates, heuristic_candidates
from shorts.types import Curve, MediaInfo, Peak, SignalIndex, Span, Word


def _mk_index(**overrides) -> SignalIndex:
    defaults = dict(
        version=1,
        media=MediaInfo(duration_s=120.0, fps=30.0, width=1920, height=1080),
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


def test_valid_llm_candidate_is_admitted(tmp_path, monkeypatch):
    """A stub response citing a real, queryable energy peak passes the
    evidence gate on the first try -- no re-ask, one call, admitted with
    source='llm'."""
    idx = _mk_index(
        words=[Word(text="hello", t0=50.0, t1=50.5, conf=0.9)],
        peaks=[Peak(t=50.0, sigma=2.2)],
    )
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        return {
            "candidates": [
                {
                    "t0": 30.0,
                    "t1": 70.0,
                    "reason": "hot take",
                    "evidence": [{"kind": "energy_peak", "t": 50.0, "value": 2.2}],
                }
            ]
        }

    monkeypatch.setattr("shorts.agents.scout.complete_json", fake_complete_json)

    result = _llm_candidates(idx, _log(tmp_path))

    assert len(calls) == 1
    assert len(result) == 1
    assert result[0].source == "llm"
    assert result[0].evidence[0].kind == "energy_peak"
    assert result[0].t0 == 30.0 and result[0].t1 == 70.0


def test_llm_candidate_citing_nonexistent_peak_is_rejected_after_reask(tmp_path, monkeypatch):
    """A stub response citing a peak that isn't in the index fails the
    evidence gate, triggers exactly one re-ask carrying the violation
    reason, and -- since the (deliberately unhelpful) stub returns the same
    bad claim again -- is discarded and logged, never admitted."""
    idx = _mk_index(
        words=[Word(text="hello", t0=50.0, t1=50.5, conf=0.9)],
        peaks=[Peak(t=50.0, sigma=2.2)],
    )
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        return {
            "candidates": [
                {
                    "t0": 0.0,
                    "t1": 20.0,
                    "reason": "hot take",
                    "evidence": [{"kind": "energy_peak", "t": 10.0, "value": 2.5}],
                }
            ]
        }

    monkeypatch.setattr("shorts.agents.scout.complete_json", fake_complete_json)
    log = _log(tmp_path)

    result = _llm_candidates(idx, log)

    assert len(calls) == 2
    assert "no energy peak" in calls[1]  # re-ask prompt carries the violation reason
    assert result == []

    records = [json.loads(line) for line in log.path.read_text().splitlines()]
    discarded = [r for r in records if r["action"] == "llm_candidate_discarded"]
    assert len(discarded) == 1
    assert discarded[0]["payload"]["reason"] == "evidence violation after re-ask"


def test_dedupe_merges_overlapping_llm_and_heuristic_higher_evidence_wins(tmp_path, monkeypatch):
    """rule (a) fires on a real peak+surge pair -> one 2-evidence heuristic
    candidate window [30, 70]. A stub LLM candidate overlapping that window
    (IoU > 0.5) cites the same two claims PLUS a valid quote -- 3 pieces of
    evidence, more than the heuristic hit -- so after cross-source dedupe
    the LLM candidate should win."""
    idx = _mk_index(
        words=[Word(text="hello", t0=50.0, t1=50.5, conf=0.9)],
        peaks=[Peak(t=50.0, sigma=2.2)],
        surges=[Span(t0=51.0, t1=54.0)],
    )
    heuristic = heuristic_candidates(idx)
    assert len(heuristic) == 1
    assert len(heuristic[0].evidence) == 2

    def fake_complete_json(prompt, schema, agent, log):
        return {
            "candidates": [
                {
                    "t0": 32.0,
                    "t1": 68.0,
                    "reason": "hot take with a quote",
                    "evidence": [
                        {"kind": "energy_peak", "t": 50.0, "value": 2.2},
                        {"kind": "rate_surge", "t": 52.0, "value": None},
                        {"kind": "quote", "t": 50.0, "value": "hello"},
                    ],
                }
            ]
        }

    monkeypatch.setattr("shorts.agents.scout.complete_json", fake_complete_json)

    result = candidates(idx, _log(tmp_path))

    assert len(result) == 1
    assert result[0].source == "llm"
    assert len(result[0].evidence) == 3


def test_stub_mode_falls_back_to_heuristic_only(tmp_path, monkeypatch):
    """No monkeypatch of complete_json -- SHORTS_LLM defaults to stub, so
    candidates() must equal heuristic_candidates() exactly, and the log
    must record that the LLM pass was skipped."""
    monkeypatch.delenv("SHORTS_LLM", raising=False)
    idx = _mk_index(
        words=[Word(text="hello", t0=50.0, t1=50.5, conf=0.9)],
        peaks=[Peak(t=50.0, sigma=2.2)],
        surges=[Span(t0=51.0, t1=54.0)],
    )
    log = _log(tmp_path)

    result = candidates(idx, log)

    assert result == heuristic_candidates(idx)

    records = [json.loads(line) for line in log.path.read_text().splitlines()]
    skipped = [r for r in records if r["action"] == "llm_pass_skipped"]
    assert len(skipped) == 1
    assert "stub mode" in skipped[0]["payload"]["reason"]
