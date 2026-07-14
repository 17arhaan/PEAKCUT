"""shorts export: gallery naming/copy logic (pure file ops, fast suite)."""

import json
from datetime import date

from shorts.export import export_run


def _mk_workdir(tmp_path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    clips = []
    for i, (title, dropped) in enumerate(
        [("Why I Never Smile?", None), ("Dropped One", "BLACK"), ("Jim Wins: Again", None)],
        start=1,
    ):
        clip_dir = tmp_path / f"clip_{i:03d}"
        clip_dir.mkdir()
        mp4 = clip_dir / "clip.mp4"
        mp4.write_bytes(b"mp4")
        (clip_dir / "thumb.jpg").write_bytes(b"jpg")
        clips.append({
            "index": i,
            "dropped_reason": dropped,
            "hook": {"title": title},
            "paths": {"mp4": str(mp4)},
        })
    (tmp_path / "run.json").write_text(json.dumps({"clips": clips}))
    return tmp_path


def test_export_names_kept_clips_from_hooks_and_skips_dropped(tmp_path):
    work = _mk_workdir(tmp_path / "work")

    out = export_run(work, "office-pranks", dest_root=tmp_path / "gallery")

    assert out == tmp_path / "gallery" / f"{date.today().isoformat()}_office-pranks"
    names = sorted(p.name for p in out.iterdir())
    # path-hostile chars stripped, spaces -> underscores, dropped clip absent
    assert names == [
        "01_Why_I_Never_Smile.jpg",
        "01_Why_I_Never_Smile.mp4",
        "03_Jim_Wins_Again.jpg",
        "03_Jim_Wins_Again.mp4",
        "run.json",
    ]
    assert (out / "01_Why_I_Never_Smile.mp4").read_bytes() == b"mp4"
    # source workdir untouched (copies, not moves -- restyle still works)
    assert (work / "clip_001" / "clip.mp4").exists()


def test_export_resolves_stale_absolute_paths_via_workdir(tmp_path):
    """run.json written on another machine carries dead absolute paths --
    export falls back to <workdir>/clip_NNN/clip.mp4."""
    work = _mk_workdir(tmp_path / "work")
    run = json.loads((work / "run.json").read_text())
    for c in run["clips"]:
        c["paths"]["mp4"] = f"/nonexistent/clip_{c['index']:03d}/clip.mp4"
    (work / "run.json").write_text(json.dumps(run))

    out = export_run(work, "x", dest_root=tmp_path / "gallery")

    assert (out / "01_Why_I_Never_Smile.mp4").exists()
