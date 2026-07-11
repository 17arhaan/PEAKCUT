"""Orchestrator: bounded Scout<->Critic debate. Scout proposes candidate
windows, Critic scores each one; candidates that land "borderline" go back
to Scout for one refinement round -- MAX_ROUNDS total, a plain for-loop, no
open-ended negotiation. Every verdict is logged for audit (candidate
window, verdict, total, voided components).

If nothing ever reaches "keep" (real content is genuinely this quiet --
Scout found no evidence-backed candidates, or Critic killed everything),
run_crew still returns a best-effort set so the pipeline never ships zero
clips -- see _best_effort.
"""

from shorts.agent_log import AgentLog
from shorts.agents.critic import score as critic_score
from shorts.agents.scout import candidates as scout_candidates, fallback_candidates
from shorts.types import Candidate, Scored, SignalIndex

MAX_ROUNDS = 2
BEST_EFFORT_N = 4


def _iou(a: Candidate, b: Candidate) -> float:
    inter = max(0.0, min(a.t1, b.t1) - max(a.t0, b.t0))
    if inter <= 0.0:
        return 0.0
    union = (a.t1 - a.t0) + (b.t1 - b.t0) - inter
    return inter / union if union > 0 else 0.0


def _log_verdict(log: AgentLog, s: Scored, round_i: int) -> None:
    voided = [name for name, (comp_score, claims) in s.components.items() if comp_score == 0 and not claims]
    log.emit(
        "orchestrator", "verdict",
        {
            "round": round_i,
            "t0": s.candidate.t0,
            "t1": s.candidate.t1,
            "verdict": s.verdict,
            "total": s.total,
            "voided": voided,
        },
    )


def run_crew(idx: SignalIndex, log: AgentLog) -> list[Scored]:
    """Scout -> Critic, up to MAX_ROUNDS. Borderline verdicts are sent back
    to Scout (with a note pointing at the borderline windows -- live mode
    re-runs Scout's LLM pass with that note appended to its prompt; stub
    mode has no LLM, so it just recomputes the same heuristic candidates,
    a no-op). "Keep" verdicts accumulate across rounds; "kill" verdicts are
    dropped for good. New candidates that overlap an already-kept window
    are filtered out before re-scoring, so a round-2 refinement can never
    duplicate a keeper. Returns keepers sorted by total desc, or a
    best-effort set if that's empty (target 5-8 keepers; fewer is fine)."""
    keepers: list[Scored] = []
    all_scored: list[Scored] = []
    cands = scout_candidates(idx, log)

    for round_i in range(MAX_ROUNDS):
        scored = [critic_score(c, idx, log) for c in cands]
        for s in scored:
            _log_verdict(log, s, round_i)
        all_scored.extend(scored)

        keepers.extend(s for s in scored if s.verdict == "keep")
        borderline = [s for s in scored if s.verdict == "borderline"]

        if not borderline or round_i == MAX_ROUNDS - 1:
            break

        note = (
            "Refine these borderline windows -- find tighter or "
            "better-evidenced candidates covering the same moments: "
            + "; ".join(f"[{s.candidate.t0:.1f},{s.candidate.t1:.1f}]" for s in borderline)
        )
        refined = scout_candidates(idx, log, note)
        cands = [c for c in refined if not any(_iou(c, k.candidate) > 0.5 for k in keepers)]

    keepers.sort(key=lambda s: -s.total)

    if not keepers:
        keepers = _best_effort(idx, log, all_scored)

    return keepers


def _best_effort(idx: SignalIndex, log: AgentLog, all_scored: list[Scored]) -> list[Scored]:
    """# ponytail: no keepers -> render best-effort, real content rarely
    this quiet. Picks the top BEST_EFFORT_N candidates ever scored, ranked
    by evidence count (even the killed/borderline ones -- real evidence
    beats none). If Scout genuinely produced nothing across every round
    (e.g. a quiet single-speaker recording with no laughter/energy peaks),
    falls back to Scout's synthetic speech-anchored windows instead so the
    pipeline still has something to render. Either way the verdict is
    forced to "borderline" -- not "keep", since nothing here actually
    earned that -- and every override is logged."""
    pool = {(s.candidate.t0, s.candidate.t1): s for s in all_scored}
    ranked = sorted(pool.values(), key=lambda s: (-len(s.candidate.evidence), s.candidate.t0))

    if not ranked:
        synthetic = fallback_candidates(idx, BEST_EFFORT_N)
        ranked = [critic_score(c, idx, log) for c in synthetic]

    out = []
    for s in ranked[:BEST_EFFORT_N]:
        forced = Scored(candidate=s.candidate, total=s.total, components=s.components, verdict="borderline")
        log.emit(
            "orchestrator", "best_effort_fallback",
            {"t0": forced.candidate.t0, "t1": forced.candidate.t1, "total": forced.total},
        )
        out.append(forced)
    return out
