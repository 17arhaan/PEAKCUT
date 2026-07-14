"""Export a run's kept clips into the gallery with human names.

`shorts run` workdirs keep machine names (clip_001/clip.mp4) because the
checkpoint/restyle machinery depends on them. This copies the kept clips out
as `<date>_<name>/NN_Hook_Title.mp4` (+ thumbnail), the naming convention of
studio/gallery -- the workdir stays untouched and restylable."""

import json
import re
import shutil
from datetime import date
from pathlib import Path

DEFAULT_GALLERY = Path(__file__).resolve().parents[3] / "studio" / "gallery"


def _slug_title(title: str) -> str:
    title = re.sub(r'[/\\:?*"<>|]', "", title).strip()
    return title.replace(" ", "_")


def export_run(workdir: Path, name: str, dest_root: Path = DEFAULT_GALLERY) -> Path:
    """Copy kept clips from `workdir` into `<dest_root>/<today>_<name>/` named
    `NN_Hook_Title.mp4` (+ .jpg thumb when present) plus the run.json receipt.
    Returns the created folder. Raises FileNotFoundError without a run.json."""
    workdir = Path(workdir)
    run = json.loads((workdir / "run.json").read_text())

    out = Path(dest_root) / f"{date.today().isoformat()}_{name}"
    out.mkdir(parents=True, exist_ok=True)

    exported = 0
    for clip in run["clips"]:
        if clip.get("dropped_reason"):
            continue
        mp4 = (clip.get("paths") or {}).get("mp4")
        if not mp4:
            continue
        # run.json paths can be absolute from another machine/run of this
        # workdir -- resolve relative to the workdir when the absolute one
        # doesn't exist.
        src = Path(mp4)
        if not src.exists():
            src = workdir / f"clip_{clip['index']:03d}" / "clip.mp4"
        if not src.exists():
            continue
        hook = clip.get("hook")
        title = hook.get("title") if isinstance(hook, dict) else (hook or f"Clip {clip['index']}")
        base = f"{clip['index']:02d}_{_slug_title(title)}"
        shutil.copy2(src, out / f"{base}.mp4")
        thumb = src.parent / "thumb.jpg"
        if thumb.exists():
            shutil.copy2(thumb, out / f"{base}.jpg")
        exported += 1

    shutil.copy2(workdir / "run.json", out / "run.json")
    print(f"exported {exported} clip(s) -> {out}")
    return out
