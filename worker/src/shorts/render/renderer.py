"""Crop/scale/burn-in a single clip. Center-crop to 9:16, scale to
1080x1920, subtitles burned in via libass. Walking-skeleton crude: one
fixed crop, no reframing yet."""

import contextlib
import os
from pathlib import Path

from shorts.ffmpeg import run
from shorts.types import Cut


@contextlib.contextmanager
def _cwd(path: Path):
    # ponytail: run ffmpeg with cwd=out_dir and a relative .ass filename so
    # the subtitles= filter never has to worry about colon/quote escaping
    # in an absolute path.
    prev = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prev)


def render_clip(video: Path, cut: Cut, ass: str, out: Path) -> Path:
    """Cut [cut.t0, cut.t1) from `video`, center-crop to 9:16, scale to
    1080x1920, and burn in the ASS subtitle content `ass`. Writes the .ass
    file alongside `out` and the rendered mp4 to `out`. Returns `out`."""
    video = Path(video).resolve()
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    ass_path = out.with_suffix(".ass")
    ass_path.write_text(ass)

    with _cwd(out.parent):
        run(
            [
                "-y",
                "-ss", str(cut.t0),
                "-i", str(video),
                "-t", str(cut.t1 - cut.t0),
                "-vf", f"crop=ih*9/16:ih,scale=1080:1920,subtitles={ass_path.name}",
                "-c:v", "libx264",
                "-c:a", "aac",
                out.name,
            ]
        )

    return out
