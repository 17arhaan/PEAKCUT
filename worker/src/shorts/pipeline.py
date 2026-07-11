"""Pipeline: video in, up to 4 candidate captioned 9:16 clips out.

Signal extraction (SignalIndex) is real; so is candidate-finding (heuristic
Scout, T6) and the QA gate (T8). Scoring/hooks are still stubs -- each gets
a real implementation in a later task.
"""

import json
from pathlib import Path

from shorts import qa
from shorts.agent_log import AgentLog
from shorts.agents import hooks
from shorts.agents.orchestrator import run_crew
from shorts.agents.scout import fallback_candidates as _fallback_candidates
from shorts.agents.surgeon import refine as surgeon_refine, repair as surgeon_repair
from shorts.render.renderer import render_clip
from shorts.signals.index import build_signal_index, save as save_signal_index
from shorts.types import Claim, ClipResult, QAReport, Scored, SourceMedia
from shorts.ffmpeg import extract_wav, probe

MAX_CLIPS = 4
# ponytail: style selection (picking s1/s2/s3 per clip) is a later task --
# one fixed caption preset for every clip. Hook titles/captions ARE
# per-clip now (hooks.write), just not the visual caption style.
DEFAULT_STYLE = "s1"
# T14: bounded repair -- QA failures route back to the responsible stage for
# a re-render/re-cut instead of dropping on the first failure, but loop at
# most this many times before giving up and dropping (some failures, e.g.
# BLACK from genuine source content, can never be fixed by re-rendering).
MAX_REPAIR_LOOPS = 2


def _repair_route(report: QAReport) -> str:
    """Which stage a QA-failed clip's repair goes through: "surgeon" if any
    failure routes there (surgeon.repair() itself ignores any other codes
    mixed in), else "render" if any failure is fixable by a bare re-render,
    else "drop" (every failure present is drop-routed -- unrepairable)."""
    routes = {f.route_to for f in report.failures}
    if "surgeon" in routes:
        return "surgeon"
    if "render" in routes:
        return "render"
    return "drop"


def _claim_json(cl: Claim) -> dict:
    return {"kind": cl.kind, "t": cl.t, "value": cl.value}


def run(source: Path, out_dir: Path) -> list[ClipResult]:
    source = Path(source)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    log = AgentLog(out_dir / "agent_events.jsonl")

    wav = extract_wav(source, out_dir / "audio.wav")
    media = SourceMedia(video=source, wav16k=wav, info=probe(source))
    index = build_signal_index(media, out_dir)
    save_signal_index(index, out_dir / "signals.json")

    words = index.words
    if not words:
        (out_dir / "run.json").write_text(json.dumps([], indent=2))
        return []

    # ponytail: render cap 4, lift when Modal parallel -- run_crew already
    # targets 5-8 keepers (fewer fine) and guarantees a non-empty,
    # best-effort list even on quiet content; this just caps what we render.
    keepers = run_crew(index, log)[:MAX_CLIPS]

    results: list[ClipResult] = []
    run_entries = []
    for i, scored in enumerate(keepers, start=1):
        candidate = scored.candidate
        clip_dir = out_dir / f"clip_{i:03d}"
        cut = surgeon_refine(candidate, index, log)
        hook = hooks.write(cut, index, log)
        mp4, thumb = render_clip(source, cut, index, hook, DEFAULT_STYLE, clip_dir)
        report = qa.check(mp4, cut, index, hook=hook)

        # T14: QA failure routes back to the responsible stage for a bounded
        # re-repair instead of dropping immediately. Each loop re-renders
        # (render_clip re-derives captions/ass from `cut` every call, so a
        # surgeon-repaired cut's captions are never stale) and re-checks the
        # NEW file -- `report`/`mp4` are reassigned each iteration, never
        # read stale after a repair.
        repairs: list[dict] = []
        attempt = 0
        while not report.passed and attempt < MAX_REPAIR_LOOPS:
            route = _repair_route(report)
            if route == "drop":
                break  # unrepairable -- doesn't count as a repair attempt
            attempt += 1
            codes = [f.code for f in report.failures]
            if route == "surgeon":
                cut = surgeon_repair(cut, index, report.failures, log)
            mp4, thumb = render_clip(source, cut, index, hook, DEFAULT_STYLE, clip_dir)
            report = qa.check(mp4, cut, index, hook=hook)
            outcome = "fixed" if report.passed else "failed"
            repairs.append({"attempt": attempt, "codes": codes, "route": route, "outcome": outcome})
            log.emit(
                "qa", "repair",
                {"clip": i, "codes": codes, "route": route, "attempt": attempt, "outcome": outcome},
            )

        # QA failure drops the clip from the shipped set but the render is
        # KEPT on disk and the run keeps going (spec Sec7: partial success
        # is success) -- only dropped_reason marks it, mp4/thumb stay set.
        dropped_reason = "; ".join(f.code for f in report.failures) if not report.passed else None

        result = ClipResult(
            mp4=mp4, thumb=thumb, cut=cut, score=scored, hook=hook, qa=report,
            dropped_reason=dropped_reason,
        )
        results.append(result)
        run_entries.append(
            {
                "mp4": str(result.mp4),
                "t0": candidate.t0,
                "t1": candidate.t1,
                "cut": {
                    "t0": result.cut.t0,
                    "t1": result.cut.t1,
                    "payoff_word_i": result.cut.payoff_word_i,
                },
                "source": candidate.source,
                "evidence": [_claim_json(cl) for cl in candidate.evidence],
                "score": {
                    "total": scored.total,
                    "verdict": scored.verdict,
                    "components": {
                        name: {"score": comp_score, "evidence": [_claim_json(cl) for cl in claims]}
                        for name, (comp_score, claims) in scored.components.items()
                    },
                },
                "qa": {
                    "passed": report.passed,
                    "failures": [{"code": f.code, "detail": f.detail} for f in report.failures],
                },
                "hook": {"title": hook.title, "captions": hook.captions},
                "repairs": repairs,
                "dropped_reason": result.dropped_reason,
            }
        )

    (out_dir / "run.json").write_text(json.dumps(run_entries, indent=2))

    return results
