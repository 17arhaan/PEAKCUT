"""Generate publish.json metadata for every kept clip in a finished workdir.
Reads the run.json + signals.json a `shorts run` already wrote, so it needs no
re-render and can be re-run any time (LIVE regenerates copy, STUB is
deterministic)."""

import json
from pathlib import Path

from shorts.agent_log import AgentLog
from shorts.publish.metadata import build_youtube_metadata
from shorts.signals.index import load as load_signal_index, words_in


def generate_youtube_metadata(out_dir: Path) -> list[Path]:
    """Write clip_NNN/publish.json for each kept (non-dropped) clip. Returns the
    publish.json paths written, in clip order."""
    out_dir = Path(out_dir)
    run = json.loads((out_dir / "run.json").read_text())
    idx = load_signal_index(out_dir / "signals.json")
    log = AgentLog(out_dir / "agent_events.jsonl")

    written: list[Path] = []
    for clip in run["clips"]:
        if clip.get("dropped_reason"):
            continue
        cut = clip["cut"]
        transcript = " ".join(w.text for w in words_in(idx, cut["t0"], cut["t1"]))
        hook_title = (clip.get("hook") or {}).get("title") or "Watch this clip"
        meta = build_youtube_metadata(hook_title, transcript, log)

        mp4 = (clip.get("paths") or {}).get("mp4")
        clip_dir = Path(mp4).parent if mp4 and Path(mp4).parent.is_dir() else out_dir
        path = clip_dir / "publish.json"
        path.write_text(json.dumps(meta, indent=2))
        written.append(path)
    return written
