"""Critic: scores a Scout candidate on four components -- hook_strength,
payoff, emotion, quotability (each 0-25, summed into a 0-100 total). A
component only counts if it's backed by >=1 Claim that resolves against the
SignalIndex (agents.evidence.validate_claims, same gate Scout's candidates
go through); a component whose evidence doesn't resolve gets ONE re-ask
carrying the violation reasons, and is VOIDED (forced to 0) if it still
doesn't resolve after that.

Verdict: total>=62 keep, total<=45 kill, else borderline -- identical in
both modes. LIVE mode asks the LLM (one scoring call plus at most one
re-ask); STUB mode (SHORTS_LLM=stub, the default -- no API key needed) has
no LLM to ask, so scoring is a deterministic function of the candidate's
own evidence count instead (see _stub_score).
"""

from shorts.agent_log import AgentLog
from shorts.agents.evidence import validate_claims
from shorts.agents.llm import LlmError, StubModeError, complete_json
from shorts.agents.scout import _CLAIM_VOCABULARY, _parse_evidence
from shorts.signals.index import words_in
from shorts.types import Candidate, Claim, Scored, SignalIndex, Span

COMPONENTS = ("hook_strength", "payoff", "emotion", "quotability")
MAX_COMPONENT_SCORE = 25
KEEP_THRESHOLD = 62
KILL_THRESHOLD = 45

CRITIC_LLM_SCHEMA = {
    "required": ["components"],
    "properties": {"components": {"type": "object"}},
}


def _verdict(total: int) -> str:
    if total >= KEEP_THRESHOLD:
        return "keep"
    if total <= KILL_THRESHOLD:
        return "kill"
    return "borderline"


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _stub_score(cand: Candidate, log: AgentLog) -> Scored:
    """# ponytail: stub scoring = 15*len(evidence) capped 90, split evenly
    across the four components (remainder to the first ones so the total
    always equals the exact sum), each citing the candidate's own evidence
    verbatim. Deterministic and fully offline -- a fallback candidate with
    no evidence scores 0 on every component -> total 0 -> kill."""
    total = min(90, 15 * len(cand.evidence))
    base, remainder = divmod(total, len(COMPONENTS))
    components: dict[str, tuple[int, list[Claim]]] = {}
    for i, name in enumerate(COMPONENTS):
        comp_score = base + (1 if i < remainder else 0)
        components[name] = (comp_score, list(cand.evidence))
    total = sum(s for s, _ in components.values())
    verdict = _verdict(total)
    log.emit(
        "critic", "scored",
        {"t0": cand.t0, "t1": cand.t1, "total": total, "verdict": verdict, "mode": "stub"},
    )
    return Scored(candidate=cand, total=total, components=components, verdict=verdict)


def _prompt(cand: Candidate, idx: SignalIndex) -> str:
    transcript = " ".join(w.text for w in words_in(idx, cand.t0, cand.t1))
    return (
        "You are the Critic agent in a shorts-clipping pipeline. Score this "
        "candidate window as a potential short-form clip on four "
        "components, each 0-25: hook_strength (grabs attention in the "
        "first seconds), payoff (delivers on the hook), emotion (evokes a "
        "reaction), quotability (has a quotable/shareable line).\n\n"
        f"Window: [{cand.t0:.1f}, {cand.t1:.1f}]\n"
        f"Transcript in window: {transcript}\n\n"
        "Every component's score must be backed by at least one evidence "
        "claim from this vocabulary ONLY, and every claim must be something "
        "you can actually observe -- do not invent timestamps or values:\n"
        f"{_CLAIM_VOCABULARY}\n\n"
        'Respond with ONLY a JSON object of the form {"components": '
        '{"hook_strength": {"score": <int 0-25>, "evidence": [{"kind": '
        '<str>, "t": <float>, "value": <float|str|null>}]}, "payoff": '
        '{...}, "emotion": {...}, "quotability": {...}}}. Include all four '
        "components. No prose, no markdown fences."
    )


def _clamp_component(raw_score: object, name: str, cand: Candidate, log: AgentLog) -> int:
    """Clamp an LLM-reported component score into [0, 25] -- the model may
    return anything (e.g. 40); this never trusts it, and logs whenever the
    raw value wasn't usable or had to be clamped."""
    if not _is_number(raw_score):
        log.emit(
            "critic", "component_score_invalid",
            {"component": name, "t0": cand.t0, "t1": cand.t1, "raw": raw_score},
        )
        return 0
    clamped = max(0, min(MAX_COMPONENT_SCORE, int(raw_score)))
    if clamped != raw_score:
        log.emit(
            "critic", "component_score_clamped",
            {"component": name, "t0": cand.t0, "t1": cand.t1, "raw": raw_score, "clamped": clamped},
        )
    return clamped


def _parse_components(
    data: dict, cand: Candidate, window: Span, idx: SignalIndex, log: AgentLog
) -> dict[str, tuple[int, list[Claim], list[str]]]:
    """Parse one complete_json response's "components" object into
    name -> (clamped score, cited claims, violation reasons). A missing
    component, malformed evidence, no evidence at all, or evidence that
    fails validate_claims all land as non-empty violations for the
    caller's re-ask/void decision."""
    raw = data.get("components")
    raw = raw if isinstance(raw, dict) else {}
    out: dict[str, tuple[int, list[Claim], list[str]]] = {}
    for name in COMPONENTS:
        entry = raw.get(name)
        if not isinstance(entry, dict):
            out[name] = (0, [], ["component missing from response"])
            continue
        clamped = _clamp_component(entry.get("score"), name, cand, log)
        claims = _parse_evidence(entry.get("evidence"))
        if claims is None:
            out[name] = (clamped, [], ["malformed evidence entry"])
            continue
        if not claims:
            out[name] = (clamped, [], ["no evidence cited"])
            continue
        violations = validate_claims(claims, idx, window)
        if violations:
            out[name] = (clamped, claims, [v.reason for v in violations])
        else:
            out[name] = (clamped, claims, [])
    return out


def _live_score(cand: Candidate, idx: SignalIndex, log: AgentLog) -> Scored:
    window = Span(t0=cand.t0, t1=cand.t1)
    prompt = _prompt(cand, idx)
    data = complete_json(prompt, CRITIC_LLM_SCHEMA, "critic", log)
    parsed = _parse_components(data, cand, window, idx, log)

    failing = {name: violations for name, (_, _, violations) in parsed.items() if violations}
    if failing:
        reasons = "\n".join(f"- {name}: " + "; ".join(v) for name, v in failing.items())
        reask_prompt = (
            f"{prompt}\n\nThe following components' evidence could not be "
            f"verified against the video's measured signals:\n{reasons}\n\n"
            "Respond again with ONLY corrected, verifiable evidence, in the "
            "same JSON schema (include all four components)."
        )
        data2 = complete_json(reask_prompt, CRITIC_LLM_SCHEMA, "critic", log)
        parsed2 = _parse_components(data2, cand, window, idx, log)
        for name in failing:
            parsed[name] = parsed2[name]

    components: dict[str, tuple[int, list[Claim]]] = {}
    for name in COMPONENTS:
        comp_score, claims, violations = parsed[name]
        if violations:
            log.emit(
                "critic", "component_voided",
                {"component": name, "t0": cand.t0, "t1": cand.t1, "violations": violations},
            )
            components[name] = (0, [])
        else:
            components[name] = (comp_score, claims)

    total = sum(s for s, _ in components.values())
    verdict = _verdict(total)
    log.emit(
        "critic", "scored",
        {"t0": cand.t0, "t1": cand.t1, "total": total, "verdict": verdict, "mode": "live"},
    )
    return Scored(candidate=cand, total=total, components=components, verdict=verdict)


def score(cand: Candidate, idx: SignalIndex, log: AgentLog) -> Scored:
    """Score `cand` on the four components. LIVE mode (SHORTS_LLM=live)
    asks the LLM; STUB mode (the default, no API key needed) never calls
    out -- `complete_json` raises StubModeError immediately and this falls
    back to the deterministic evidence-count formula.

    An LlmError (the model never produced schema-valid JSON, even after the
    re-ask + retry) degrades to the SAME deterministic formula for THIS
    candidate instead of propagating -- one malformed response must never
    kill the whole run (observed live: a single bad critic reply aborted an
    entire pipeline). The degradation is logged for the audit trail."""
    try:
        return _live_score(cand, idx, log)
    except StubModeError:
        return _stub_score(cand, log)
    except LlmError as e:
        log.emit(
            "critic", "degraded_to_stub",
            {"t0": cand.t0, "t1": cand.t1, "reason": str(e)[:300]},
        )
        return _stub_score(cand, log)
