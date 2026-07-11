"""Tests for the Critic (component scoring, evidence-gated re-ask/void) and
the Scout<->Critic orchestrator round loop. Hand-built tiny SignalIndex
objects and monkeypatched complete_json -- no real media, consistent with
test_scout.py/test_scout_llm.py."""

import json

from shorts.agent_log import AgentLog
from shorts.agents import critic, orchestrator
from shorts.agents.critic import score as critic_score
from shorts.agents.orchestrator import run_crew
from shorts.types import Candidate, Claim, Curve, MediaInfo, Peak, Scored, SignalIndex, Span, Word


def _mk_index(**overrides) -> SignalIndex:
    defaults = dict(
        version=1,
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
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


def _log(tmp_path, name: str = "agent_events.jsonl") -> AgentLog:
    return AgentLog(tmp_path / name)


def _records(log: AgentLog) -> list[dict]:
    return [json.loads(line) for line in log.path.read_text().splitlines()]


# --- stub-mode scoring ----------------------------------------------------


def test_stub_score_no_evidence_is_killed(tmp_path):
    cand = Candidate(t0=0.0, t1=20.0, source="fallback", evidence=[])
    idx = _mk_index()

    scored = critic_score(cand, idx, _log(tmp_path))

    assert scored.total == 0
    assert scored.verdict == "kill"
    assert all(comp == (0, []) for comp in scored.components.values())


def test_stub_score_enough_evidence_is_kept(tmp_path):
    """5 evidence claims -> total = min(90, 15*5) = 75 -> keep. Every
    component cites the candidate's own evidence, and the four component
    scores sum exactly back to the total."""
    evidence = [Claim(kind="energy_peak", t=float(i), value=1.0) for i in range(5)]
    cand = Candidate(t0=0.0, t1=20.0, source="rule_a_energy_rate", evidence=evidence)
    idx = _mk_index()

    scored = critic_score(cand, idx, _log(tmp_path))

    assert scored.total == 75
    assert scored.verdict == "keep"
    assert sum(comp_score for comp_score, _ in scored.components.values()) == 75
    for comp_score, claims in scored.components.values():
        assert 0 <= comp_score <= 25
        assert claims == evidence


def test_stub_score_kill_threshold_boundary(tmp_path):
    """3 claims -> total = 45, exactly the kill boundary (<=45)."""
    evidence = [Claim(kind="energy_peak", t=float(i), value=1.0) for i in range(3)]
    cand = Candidate(t0=0.0, t1=20.0, source="rule_a_energy_rate", evidence=evidence)
    idx = _mk_index()

    scored = critic_score(cand, idx, _log(tmp_path))

    assert scored.total == 45
    assert scored.verdict == "kill"


def test_stub_score_is_deterministic(tmp_path):
    evidence = [Claim(kind="rate_surge", t=1.0), Claim(kind="quote", t=2.0, value="hi")]
    cand = Candidate(t0=5.0, t1=25.0, source="llm", evidence=evidence)
    idx = _mk_index()

    a = critic_score(cand, idx, _log(tmp_path, "a.jsonl"))
    b = critic_score(cand, idx, _log(tmp_path, "b.jsonl"))

    assert a == b


# --- live-mode scoring (complete_json monkeypatched) -----------------------


def test_component_without_valid_claim_is_voided_after_reask(tmp_path, monkeypatch):
    """quotability cites a quote that never appears in the transcript --
    fails the evidence gate on the first try, triggers exactly one re-ask
    carrying the violation reason, and (the stub deliberately repeats the
    same bad claim) is voided: score forced to 0, no cited claims, logged."""
    idx = _mk_index(words=[Word(text="hello", t0=50.0, t1=50.5, conf=0.9)], peaks=[Peak(t=50.0, sigma=2.2)])
    cand = Candidate(t0=30.0, t1=70.0, source="llm", evidence=[])
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        good_claim = {"kind": "energy_peak", "t": 50.0, "value": 2.2}
        return {
            "components": {
                "hook_strength": {"score": 20, "evidence": [good_claim]},
                "payoff": {"score": 18, "evidence": [good_claim]},
                "emotion": {"score": 15, "evidence": [good_claim]},
                "quotability": {
                    "score": 22,
                    "evidence": [{"kind": "quote", "t": 50.0, "value": "goodbye"}],
                },
            }
        }

    monkeypatch.setattr(critic, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    scored = critic_score(cand, idx, log)

    assert len(calls) == 2
    assert "quote" in calls[1] and "not found in transcript" in calls[1]
    assert scored.components["quotability"] == (0, [])
    assert scored.components["hook_strength"] == (20, [Claim(kind="energy_peak", t=50.0, value=2.2)])
    assert scored.total == 20 + 18 + 15 + 0
    assert scored.verdict == "borderline"

    voided = [r for r in _records(log) if r["action"] == "component_voided"]
    assert len(voided) == 1
    assert voided[0]["payload"]["component"] == "quotability"


def test_component_score_clamped_and_invalid_are_handled(tmp_path, monkeypatch):
    """The LLM can return an out-of-range score (40, above the 0-25 cap) or
    a non-numeric one -- both must be clamped/zeroed rather than trusted or
    crashing, and both get logged. No re-ask happens here since all four
    components' evidence resolves fine on the first try."""
    idx = _mk_index(peaks=[Peak(t=10.0, sigma=1.0)])
    cand = Candidate(t0=0.0, t1=20.0, source="llm", evidence=[])
    good_claim = {"kind": "energy_peak", "t": 10.0, "value": 1.0}
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        return {
            "components": {
                "hook_strength": {"score": 40, "evidence": [good_claim]},
                "payoff": {"score": "bogus", "evidence": [good_claim]},
                "emotion": {"score": 10, "evidence": [good_claim]},
                "quotability": {"score": 5, "evidence": [good_claim]},
            }
        }

    monkeypatch.setattr(critic, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    scored = critic_score(cand, idx, log)

    assert len(calls) == 1  # no re-ask -- every component's evidence resolved
    assert scored.components["hook_strength"][0] == 25  # clamped down from 40
    assert scored.components["payoff"][0] == 0  # non-numeric -> 0
    assert scored.total == 25 + 0 + 10 + 5
    assert scored.verdict == "kill"

    records = _records(log)
    assert any(r["action"] == "component_score_clamped" and r["payload"]["raw"] == 40 for r in records)
    assert any(r["action"] == "component_score_invalid" and r["payload"]["raw"] == "bogus" for r in records)


# --- orchestrator round loop -----------------------------------------------


def test_round_loop_terminates_at_two_rounds_with_always_borderline(tmp_path, monkeypatch):
    """Scout keeps proposing the same candidate, Critic keeps calling it
    borderline -- the plain for-loop must still stop after MAX_ROUNDS=2,
    not negotiate forever."""
    idx = _mk_index()
    cand = Candidate(t0=10.0, t1=30.0, source="llm", evidence=[Claim(kind="quote", t=10.0, value="x")])
    scout_calls = []
    critic_calls = []

    def fake_scout_candidates(idx, log, note=""):
        scout_calls.append(note)
        return [cand]

    def fake_critic_score(c, idx, log):
        critic_calls.append(c.t0)
        return Scored(candidate=c, total=50, components={n: (12, list(c.evidence)) for n in critic.COMPONENTS}, verdict="borderline")

    monkeypatch.setattr(orchestrator, "scout_candidates", fake_scout_candidates)
    monkeypatch.setattr(orchestrator, "critic_score", fake_critic_score)
    log = _log(tmp_path)

    result = run_crew(idx, log)

    assert len(scout_calls) == 2  # initial round + exactly one refine round
    assert len(critic_calls) == 2  # one score per round, never more

    records = _records(log)
    rounds_seen = {r["payload"]["round"] for r in records if r["action"] == "verdict"}
    assert rounds_seen == {0, 1}

    # never-kept, always-borderline -> best-effort fallback kicks in, using
    # the one candidate that was actually scored (not a synthetic window).
    assert len(result) == 1
    assert result[0].verdict == "borderline"
    assert any(r["action"] == "best_effort_fallback" for r in records)


def test_borderline_round_does_not_duplicate_kept_candidates(tmp_path, monkeypatch):
    """Round 2 must dedupe its refined candidates against round 1's
    keepers -- a candidate already kept must not be re-scored/duplicated
    just because Scout proposes an overlapping window again."""
    idx = _mk_index()
    kept = Candidate(t0=0.0, t1=20.0, source="llm", evidence=[])
    still_borderline = Candidate(t0=30.0, t1=50.0, source="llm", evidence=[])
    fresh = Candidate(t0=60.0, t1=80.0, source="llm", evidence=[])
    scout_round = {"n": 0}

    def fake_scout_candidates(idx, log, note=""):
        scout_round["n"] += 1
        if scout_round["n"] == 1:
            return [kept, still_borderline]
        # round 2: Scout re-proposes the already-kept window (should be
        # filtered out) plus one genuinely new window.
        return [kept, fresh]

    def fake_critic_score(c, idx, log):
        verdict = "keep" if c.t0 == 0.0 else "borderline" if c is still_borderline else "keep"
        total = 80 if verdict == "keep" else 50
        return Scored(candidate=c, total=total, components={n: (total // 4, []) for n in critic.COMPONENTS}, verdict=verdict)

    scored_t0s = []
    real_fake = fake_critic_score

    def tracking_critic_score(c, idx, log):
        scored_t0s.append(c.t0)
        return real_fake(c, idx, log)

    monkeypatch.setattr(orchestrator, "scout_candidates", fake_scout_candidates)
    monkeypatch.setattr(orchestrator, "critic_score", tracking_critic_score)
    log = _log(tmp_path)

    result = run_crew(idx, log)

    # `kept` (t0=0.0) must only ever be scored once, in round 1.
    assert scored_t0s.count(0.0) == 1
    windows = {(s.candidate.t0, s.candidate.t1) for s in result}
    assert (0.0, 20.0) in windows
    assert (60.0, 80.0) in windows
    assert all(s.verdict == "keep" for s in result)


def test_best_effort_fallback_when_scout_finds_nothing(tmp_path):
    """Real stub-mode path (no monkeypatching): a quiet index with no
    heuristic signals at all -- Scout finds zero candidates every round, so
    run_crew must fall back to Scout's synthetic speech-anchored windows,
    score them (stub scoring on empty evidence -> kill), and force their
    verdict to "borderline" so the pipeline still has something to render."""
    idx = _mk_index(media=MediaInfo(duration_s=60.0, fps=30.0, width=1920, height=1080), speech=[Span(t0=0.0, t1=60.0)])
    log = _log(tmp_path)

    result = run_crew(idx, log)

    assert len(result) >= 1
    assert all(s.verdict == "borderline" for s in result)
    assert all(s.candidate.evidence == [] for s in result)

    records = _records(log)
    fallback_records = [r for r in records if r["action"] == "best_effort_fallback"]
    assert len(fallback_records) == len(result)
