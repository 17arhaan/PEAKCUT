"""Pipeline: video in, up to 4 candidate captioned 9:16 clips out.

Signal extraction (SignalIndex) is real; so is candidate-finding (heuristic
Scout, T6). Scoring/hooks/QA are still stubs -- each gets a real
implementation in a later task.
"""

import json
from pathlib import Path

from shorts.agents.scout import MIN_LEN_S, heuristic_candidates
from shorts.render.captions import words_to_ass
from shorts.render.renderer import render_clip
from shorts.signals.index import build_signal_index, save as save_signal_index
from shorts.types import Candidate, ClipResult, Cut, SourceMedia
from shorts.ffmpeg import extract_wav, probe

RESOLUTION = (1080, 1920)
MAX_CLIPS = 4


def _fallback_candidates(idx, n: int) -> list[Candidate]:
    """ponytail: fallback keeps pipeline alive on quiet content; Critic will
    kill these later. Evenly-spaced windows over the whole video, no
    evidence attached -- used only to pad the Scout's real candidates up to
    MAX_CLIPS on content where the heuristic rules genuinely found nothing
    (e.g. a quiet single-speaker recording with no laughter/energy peaks).
    """
    duration = idx.media.duration_s
    if duration <= 0 or n <= 0:
        return []

    span = min(30.0, max(MIN_LEN_S, duration / n))
    out = []
    for i in range(n):
        t0 = i * duration / n
        t1 = min(duration, t0 + span)
        if t1 - t0 < MIN_LEN_S:
            t0 = max(0.0, t1 - MIN_LEN_S)
        if t1 > t0:
            out.append(Candidate(t0=t0, t1=t1, source="fallback", evidence=[]))
    return out


def run(source: Path, out_dir: Path) -> list[ClipResult]:
    source = Path(source)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    wav = extract_wav(source, out_dir / "audio.wav")
    media = SourceMedia(video=source, wav16k=wav, info=probe(source))
    index = build_signal_index(media, out_dir)
    save_signal_index(index, out_dir / "signals.json")

    words = index.words
    if not words:
        (out_dir / "run.json").write_text(json.dumps([], indent=2))
        return []

    candidates = heuristic_candidates(index)
    if len(candidates) < MAX_CLIPS:
        candidates = candidates + _fallback_candidates(index, MAX_CLIPS - len(candidates))
    candidates.sort(key=lambda c: (-len(c.evidence), c.t0))
    top = candidates[:MAX_CLIPS]

    results: list[ClipResult] = []
    run_entries = []
    for i, candidate in enumerate(top, start=1):
        cut = Cut(t0=candidate.t0, t1=candidate.t1)
        clip_words = [w for w in words if cut.t0 <= w.t0 < cut.t1]

        ass = words_to_ass(clip_words, style="Default", resolution=RESOLUTION)
        mp4 = render_clip(source, cut, ass, out_dir / f"clip_{i:03d}.mp4")

        result = ClipResult(mp4=mp4, thumb=None, cut=cut, score=None, hook=None, qa=None)
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
            }
        )

    (out_dir / "run.json").write_text(json.dumps(run_entries, indent=2))

    return results
