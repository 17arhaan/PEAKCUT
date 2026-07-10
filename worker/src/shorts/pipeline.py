"""Walking-skeleton pipeline: video in, captioned 9:16 clip out.

Deliberately crude end-to-end wiring -- each stage (picker, captions,
render) gets a real implementation in a later task. This module's job is
just to prove the wires connect.
"""

import json
from pathlib import Path

from shorts.render.captions import words_to_ass
from shorts.render.renderer import render_clip
from shorts.signals.index import build_signal_index, save as save_signal_index
from shorts.types import ClipResult, Cut, SourceMedia
from shorts.ffmpeg import extract_wav, probe

RESOLUTION = (1080, 1920)
# ponytail: crude picker, replaced in T6 -- first 30s of speech, no scoring.
CLIP_LEN_S = 30.0


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

    t0 = index.speech[0].t0 if index.speech else words[0].t0
    t1 = t0 + CLIP_LEN_S
    cut = Cut(t0=t0, t1=t1)
    clip_words = [w for w in words if t0 <= w.t0 < t1]

    ass = words_to_ass(clip_words, style="Default", resolution=RESOLUTION)
    mp4 = render_clip(source, cut, ass, out_dir / "clip_0.mp4")

    result = ClipResult(mp4=mp4, thumb=None, cut=cut, score=None, hook=None, qa=None)

    (out_dir / "run.json").write_text(
        json.dumps(
            [{"mp4": str(result.mp4), "t0": result.cut.t0, "t1": result.cut.t1}],
            indent=2,
        )
    )

    return [result]
