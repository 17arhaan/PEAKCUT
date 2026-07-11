"""Pipeline: video in, up to 4 candidate captioned 9:16 clips out.

Signal extraction (SignalIndex) is real; so is candidate-finding (heuristic
Scout, T6) and the QA gate (T8). Scoring/hooks are still stubs -- each gets
a real implementation in a later task.
"""

import json
from pathlib import Path

from shorts import qa
from shorts.agent_log import AgentLog
from shorts.agents.scout import MIN_LEN_S, candidates as scout_candidates
from shorts.render.renderer import render_clip
from shorts.signals.index import build_signal_index, save as save_signal_index
from shorts.types import Candidate, ClipResult, Cut, SignalIndex, SourceMedia, Span
from shorts.ffmpeg import extract_wav, probe

MAX_CLIPS = 4
# ponytail: hooks/style selection are later tasks -- one fixed caption
# preset for every clip until hook-generation/scoring picks per-clip style.
DEFAULT_STYLE = "s1"


def _window_around(mid: float, span: float, duration: float) -> tuple[float, float]:
    """A `span`-second window centered on `mid`, shifted (not just clipped)
    to stay inside [0, duration] -- same edge-padding idea as
    scout._clamp_windows' short-window case."""
    t0 = mid - span / 2
    t1 = mid + span / 2
    if t0 < 0.0:
        t1 += -t0
        t0 = 0.0
    if t1 > duration:
        t0 -= t1 - duration
        t1 = duration
    return max(0.0, t0), t1


def _iou(a0: float, a1: float, b0: float, b1: float) -> float:
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    if inter <= 0.0:
        return 0.0
    union = (a1 - a0) + (b1 - b0) - inter
    return inter / union if union > 0 else 0.0


def _speech_time_at(speech: list[Span], virtual_t: float) -> float:
    """Map a position on the "concatenated speech spans" virtual timeline
    back to a real timestamp."""
    cum = 0.0
    for s in speech:
        length = s.t1 - s.t0
        if virtual_t <= cum + length:
            return s.t0 + (virtual_t - cum)
        cum += length
    return speech[-1].t1 if speech else virtual_t


def _fallback_candidates(idx: SignalIndex, n: int) -> list[Candidate]:
    """ponytail: fallback keeps pipeline alive on quiet content; Critic will
    kill these later. Evenly-spaced SPEECH-WINDOW candidates, no evidence
    attached -- used only to pad the Scout's real candidates up to MAX_CLIPS
    on content where the heuristic rules genuinely found nothing (e.g. a
    quiet single-speaker recording with no laughter/energy peaks).

    N target midpoints are spread evenly across the total speech coverage
    (idx.speech spans concatenated into one virtual timeline), then mapped
    back to real time -- so windows land inside/anchored to speech instead
    of possibly landing in a silent stretch.
    """
    duration = idx.media.duration_s
    if duration <= 0 or n <= 0:
        return []

    speech = sorted(idx.speech, key=lambda s: s.t0)
    total_speech = sum(max(0.0, s.t1 - s.t0) for s in speech)
    span = min(30.0, max(MIN_LEN_S, duration / n))

    if total_speech <= 0.0:
        # ponytail: no speech at all (e.g. a hand-built index, or a truly
        # silent clip) -- nothing to anchor to, so fall back to the old
        # duration-based even spacing.
        midpoints = [(i + 0.5) * duration / n for i in range(n)]
    else:
        midpoints = [_speech_time_at(speech, (i + 0.5) * total_speech / n) for i in range(n)]

    out: list[Candidate] = []
    for mid in midpoints:
        t0, t1 = _window_around(mid, span, duration)
        if t1 - t0 < 1e-9:
            continue
        # very short video: evenly-spaced midpoints can land closer together
        # than the window width, producing overlapping near-duplicate
        # windows once each is clamped/shifted to fit -- drop those extras
        # rather than emit them.
        if any(_iou(t0, t1, c.t0, c.t1) > 0.5 for c in out):
            continue
        out.append(Candidate(t0=t0, t1=t1, source="fallback", evidence=[]))
    return out


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

    candidates = scout_candidates(index, log)
    if len(candidates) < MAX_CLIPS:
        candidates = candidates + _fallback_candidates(index, MAX_CLIPS - len(candidates))
    candidates.sort(key=lambda c: (-len(c.evidence), c.t0))
    top = candidates[:MAX_CLIPS]

    results: list[ClipResult] = []
    run_entries = []
    for i, candidate in enumerate(top, start=1):
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
            mp4=mp4, thumb=thumb, cut=cut, score=None, hook=None, qa=report,
            dropped_reason=dropped_reason,
        )
        results.append(result)
        run_entries.append(
            {
                "mp4": str(result.mp4),
                "t0": result.cut.t0,
                "t1": result.cut.t1,
                "source": candidate.source,
                "evidence": [
                    {"kind": cl.kind, "t": cl.t, "value": cl.value} for cl in candidate.evidence
                ],
                "qa": {
                    "passed": report.passed,
                    "failures": [{"code": f.code, "detail": f.detail} for f in report.failures],
                },
                "dropped_reason": result.dropped_reason,
            }
        )

    (out_dir / "run.json").write_text(json.dumps(run_entries, indent=2))

    return results
