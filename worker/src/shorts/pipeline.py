"""Pipeline: video in, up to 4 candidate captioned 9:16 clips out.

Signal extraction (SignalIndex) is real; so is candidate-finding (heuristic
Scout, T6) and the QA gate (T8). Scoring/hooks are still stubs -- each gets
a real implementation in a later task.
"""

import json
from pathlib import Path

from shorts import qa
from shorts.agent_log import AgentLog
from shorts.agents.orchestrator import run_crew
from shorts.agents.scout import fallback_candidates as _fallback_candidates
from shorts.render.renderer import render_clip
from shorts.signals.index import build_signal_index, save as save_signal_index
from shorts.types import Claim, ClipResult, Cut, Scored, SourceMedia
from shorts.ffmpeg import extract_wav, probe

MAX_CLIPS = 4
# ponytail: hooks/style selection are later tasks -- one fixed caption
# preset for every clip until hook-generation/scoring picks per-clip style.
DEFAULT_STYLE = "s1"


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
        cut = Cut(t0=candidate.t0, t1=candidate.t1)
        mp4, thumb = render_clip(
            source, cut, index, None, DEFAULT_STYLE, out_dir / f"clip_{i:03d}"
        )

        report = qa.check(mp4, cut, index)
        # QA failure drops the clip from the shipped set but the render is
        # KEPT on disk and the run keeps going (spec Sec7: partial success
        # is success) -- only dropped_reason marks it, mp4/thumb stay set.
        dropped_reason = "; ".join(f.code for f in report.failures) if not report.passed else None

        result = ClipResult(
            mp4=mp4, thumb=thumb, cut=cut, score=scored, hook=None, qa=report,
            dropped_reason=dropped_reason,
        )
        results.append(result)
        run_entries.append(
            {
                "mp4": str(result.mp4),
                "t0": result.cut.t0,
                "t1": result.cut.t1,
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
                "dropped_reason": result.dropped_reason,
            }
        )

    (out_dir / "run.json").write_text(json.dumps(run_entries, indent=2))

    return results
