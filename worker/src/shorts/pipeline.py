"""Pipeline: video in, up to 4 candidate captioned 9:16 clips out.

T17 restructures this into checkpointed stages -- ingest/media, signals,
crew (scored), cuts+render+qa+repair -- each persisted to a JSON artifact
in `out_dir` (media.json, signals.json, scored.json, cuts.json + clip_NNN/
dirs). Re-running `run()` against the same `out_dir` skips any stage whose
artifact already exists and validates for the SAME source (this is the
Modal-retry story: a stage function can crash/retry freely, the next
attempt resumes instead of redoing expensive work). Source identity is
guarded per-artifact (media.json/scored.json/cuts.json each carry their own
"source" field, checked against the current call's `source` argument, PLUS
a cheap size+mtime "fingerprint" of the resolved video file -- see
_source_fingerprint) so a workdir accidentally reused for a different video,
or the SAME path silently swapped to different content, never mixes stale
checkpoints with fresh ones -- see _load_media_checkpoint et al.
`signals.json` itself carries no source field (index.save/load's schema is
reused as-is, untouched); its reuse is instead gated on media.json having
already proven a source match THIS call (see run()) -- equivalent
protection without touching the SignalIndex schema.

`shorts render --from <workdir> --style <style>` (pipeline.render_style)
re-renders every persisted cut with a new caption style from cuts.json +
signals.json alone -- no re-transcription, no crew, no LLM calls (QA is
pure-code) -- into a style-suffixed `clips-<style>/` dir plus a sibling
`run-<style>.json` (simpler than threading a per-style map through the
original run.json).
"""

import importlib.metadata
import json
import time
from pathlib import Path

from shorts import ingest, qa
from shorts.agent_log import AgentLog
from shorts.agents import hooks
from shorts.agents.orchestrator import run_crew
from shorts.agents.surgeon import refine as surgeon_refine, repair as surgeon_repair
from shorts.ingest import IngestError
from shorts.render.captions import _PRESETS
from shorts.render.renderer import render_clip
from shorts.signals.index import build_signal_index, load as load_signal_index, save as save_signal_index
from shorts.types import (
    Candidate,
    Claim,
    Cut,
    Hook,
    MediaInfo,
    QAFail,
    QAReport,
    ClipResult,
    Scored,
    SourceMedia,
)

MAX_CLIPS = 4
# ponytail: style selection (picking s1/s2/s3 per clip) is a later task --
# one fixed caption preset for every clip's FIRST render; render_style()
# below is how a different style gets applied after the fact.
DEFAULT_STYLE = "s1"
# T14: bounded repair -- QA failures route back to the responsible stage for
# a re-render/re-cut instead of dropping on the first failure, but loop at
# most this many times before giving up and dropping (some failures, e.g.
# BLACK from genuine source content, can never be fixed by re-rendering).
MAX_REPAIR_LOOPS = 2

# Checkpoint file schema version -- bump if a persisted artifact's shape
# changes incompatibly (mirrors signals/index.py's own SCHEMA_VERSION
# pattern, kept as a separate constant since these artifacts are pipeline-
# owned, not SignalIndex-owned).
CHECKPOINT_VERSION = 1
RUN_SCHEMA_VERSION = 1


def _pipeline_version() -> str:
    try:
        return importlib.metadata.version("shorts")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0-dev"


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


# --- JSON (de)serialization helpers -- hand-written to/from dicts, same
# style as signals/index.py's save/load (no pickle, no new deps). Shared
# between the scored/cuts checkpoints AND the final run.json/run-<style>.json
# output -- one dict shape for a clip record, read by both. ------------------


def _claim_json(cl: Claim) -> dict:
    return {"kind": cl.kind, "t": cl.t, "value": cl.value}


def _claim_from_json(d: dict) -> Claim:
    return Claim(kind=d["kind"], t=d["t"], value=d.get("value"))


def _candidate_json(c: Candidate) -> dict:
    return {
        "t0": c.t0, "t1": c.t1, "source": c.source, "notes": c.notes,
        "evidence": [_claim_json(cl) for cl in c.evidence],
    }


def _candidate_from_json(d: dict) -> Candidate:
    return Candidate(
        t0=d["t0"], t1=d["t1"], source=d["source"], notes=d.get("notes", ""),
        evidence=[_claim_from_json(e) for e in d.get("evidence", [])],
    )


def _scored_json(s: Scored) -> dict:
    return {
        "total": s.total,
        "verdict": s.verdict,
        "components": {
            name: {"score": comp_score, "evidence": [_claim_json(cl) for cl in claims]}
            for name, (comp_score, claims) in s.components.items()
        },
    }


def _scored_from_json(candidate: Candidate, d: dict) -> Scored:
    components = {
        name: (comp["score"], [_claim_from_json(e) for e in comp.get("evidence", [])])
        for name, comp in d.get("components", {}).items()
    }
    return Scored(candidate=candidate, total=d["total"], verdict=d["verdict"], components=components)


def _cut_from_json(d: dict) -> Cut:
    return Cut(t0=d["t0"], t1=d["t1"], payoff_word_i=d.get("payoff_word_i"))


def _hook_from_json(d: dict | None) -> Hook | None:
    if d is None:
        return None
    return Hook(title=d["title"], captions=d["captions"])


def _qa_from_json(d: dict | None) -> QAReport | None:
    if d is None:
        return None
    # route_to isn't part of the persisted shape (it's an internal repair-
    # routing detail, never re-consulted once a clip's final state is
    # loaded back) -- "drop" is a harmless placeholder.
    return QAReport(
        passed=d["passed"],
        failures=[QAFail(code=f["code"], detail=f["detail"], route_to="drop") for f in d.get("failures", [])],
    )


def _clip_entry(
    i: int,
    candidate: Candidate,
    cut: Cut,
    scored: Scored | None,
    hook: Hook | None,
    report: QAReport | None,
    repairs: list[dict],
    dropped_reason: str | None,
    mp4: Path | None,
    thumb: Path | None,
) -> dict:
    """The per-clip record: candidate window, cut, score (the "why this
    clip" data -- total/verdict/per-component score+cited evidence), hook,
    qa result, repair history, dropped reason, and output paths. Used
    verbatim for both cuts.json's "clips" list and run.json's/
    run-<style>.json's "clips" list -- one shape, read by both."""
    return {
        "index": i,
        "candidate": _candidate_json(candidate),
        "cut": {"t0": cut.t0, "t1": cut.t1, "payoff_word_i": cut.payoff_word_i},
        "score": _scored_json(scored) if scored is not None else None,
        "hook": {"title": hook.title, "captions": hook.captions} if hook is not None else None,
        "qa": (
            {"passed": report.passed, "failures": [{"code": f.code, "detail": f.detail} for f in report.failures]}
            if report is not None else None
        ),
        "repairs": repairs,
        "dropped_reason": dropped_reason,
        "paths": {"mp4": str(mp4) if mp4 else None, "thumb": str(thumb) if thumb else None},
    }


def _clip_result_from_entry(entry: dict) -> ClipResult:
    mp4 = Path(entry["paths"]["mp4"]) if entry["paths"].get("mp4") else None
    thumb = Path(entry["paths"]["thumb"]) if entry["paths"].get("thumb") else None
    candidate = _candidate_from_json(entry["candidate"])
    score = _scored_from_json(candidate, entry["score"]) if entry.get("score") is not None else None
    return ClipResult(
        mp4=mp4, thumb=thumb,
        cut=_cut_from_json(entry["cut"]),
        score=score,
        hook=_hook_from_json(entry.get("hook")),
        qa=_qa_from_json(entry.get("qa")),
        dropped_reason=entry.get("dropped_reason"),
        repairs=entry.get("repairs", []),
    )


# --- stage checkpoints ------------------------------------------------------


def _source_fingerprint(path: Path) -> str:
    """Cheap (no hashing) content identity for `path` -- size+mtime, since
    this runs on every checkpoint load and has to stay free. For a local
    source, `path` IS the source file, so this changes the instant someone
    swaps different content in at the same path (finding: string equality
    alone can't see that). For a URL source there's nothing local to stat
    BEFORE the download (that's the whole point of resuming), so `path` is
    instead the already-downloaded video file -- this proves a later load
    still points at the exact bytes this checkpoint was written against."""
    st = path.stat()
    return f"{st.st_size}:{int(st.st_mtime)}"


def _discard(path: Path, reason: str) -> None:
    """Every checkpoint-discard branch below funnels through here so a
    stale/malformed artifact says WHY it's being regenerated instead of
    silently vanishing -- one-line, same style as cli.py's [ok]/[FAIL]."""
    print(f"[pipeline] discarding {path.name}: {reason}")
    return None


def _media_checkpoint_path(out_dir: Path) -> Path:
    return out_dir / "media.json"


def _write_media_checkpoint(out_dir: Path, source: str, media: SourceMedia) -> None:
    data = {
        "version": CHECKPOINT_VERSION,
        "source": source,
        "fingerprint": _source_fingerprint(media.video),
        "video": str(media.video),
        "wav16k": str(media.wav16k),
        "info": {
            "duration_s": media.info.duration_s, "fps": media.info.fps,
            "width": media.info.width, "height": media.info.height,
        },
    }
    _media_checkpoint_path(out_dir).write_text(json.dumps(data, indent=2))


def _load_media_checkpoint(out_dir: Path, source: str) -> SourceMedia | None:
    """The ingest-stage checkpoint. None (stage must rerun) if missing,
    unparseable/wrong-shape, from a different source, its content
    fingerprint no longer matches (same path, swapped content), or its
    referenced video/wav files no longer exist on disk."""
    path = _media_checkpoint_path(out_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return _discard(path, "checkpoint is valid JSON but not an object")
    if data.get("version") != CHECKPOINT_VERSION or data.get("source") != source:
        return None
    video, wav = Path(data.get("video", "")), Path(data.get("wav16k", ""))
    info_d = data.get("info")
    if not video.exists() or not wav.exists() or not isinstance(info_d, dict):
        return None
    if _source_fingerprint(video) != data.get("fingerprint"):
        return _discard(path, "source content changed since this checkpoint was written")
    try:
        info = MediaInfo(
            duration_s=info_d["duration_s"], fps=info_d["fps"],
            width=info_d["width"], height=info_d["height"],
        )
    except KeyError:
        return None
    return SourceMedia(video=video, wav16k=wav, info=info)


def _load_signals_checkpoint(out_dir: Path):
    """The signals-stage checkpoint (signals.json, index.save/load's own
    schema -- reused as-is). Caller only consults this when a valid
    media.json already proved the source matches THIS run (signals.json
    itself carries no source field of its own)."""
    path = out_dir / "signals.json"
    if not path.exists():
        return None
    try:
        return load_signal_index(path)
    except (json.JSONDecodeError, ValueError, KeyError, AttributeError, TypeError):
        return None


def _scored_checkpoint_path(out_dir: Path) -> Path:
    return out_dir / "scored.json"


def _write_scored_checkpoint(out_dir: Path, source: str, fingerprint: str, keepers: list[Scored]) -> None:
    data = {
        "version": CHECKPOINT_VERSION,
        "source": source,
        "fingerprint": fingerprint,
        "keepers": [
            {"candidate": _candidate_json(s.candidate), **_scored_json(s)} for s in keepers
        ],
    }
    _scored_checkpoint_path(out_dir).write_text(json.dumps(data, indent=2))


def _load_scored_checkpoint(out_dir: Path, source: str, fingerprint: str) -> list[Scored] | None:
    """The crew-stage checkpoint. `candidates.json` is deliberately not a
    separate artifact -- Scout<->Critic (orchestrator.run_crew) is one
    bounded, atomic debate with no useful mid-loop resume point, and every
    kept Scored already embeds its own Candidate, so a second file would
    just be redundant. None (stage must rerun) if missing/unparseable/
    wrong-shape, from a different source, or its fingerprint doesn't match
    THIS call's already-validated media (`fingerprint` is media.json's own
    fingerprint, recomputed by the caller -- not re-derived here -- so a
    scored.json left over from a content swap that media.json already
    caught and regenerated for gets caught too, even though its `source`
    string still matches)."""
    path = _scored_checkpoint_path(out_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return _discard(path, "checkpoint is valid JSON but not an object")
    if data.get("version") != CHECKPOINT_VERSION or data.get("source") != source:
        return None
    if data.get("fingerprint") != fingerprint:
        return _discard(path, "source content changed since this checkpoint was written")
    raw = data.get("keepers")
    if not isinstance(raw, list):
        return None
    try:
        return [_scored_from_json(_candidate_from_json(k["candidate"]), k) for k in raw]
    except (KeyError, TypeError):
        return None


def _cuts_checkpoint_path(out_dir: Path) -> Path:
    return out_dir / "cuts.json"


def _load_cuts_checkpoint(
    out_dir: Path, source: str, fingerprint: str
) -> tuple[list[ClipResult], list[dict]] | None:
    """The cuts+render+qa+repair-stage checkpoint. Persists the FINAL,
    post-repair state (repairs mutate the cut BEFORE this is written --
    cuts.json is only ever written once the per-clip repair loop has
    already settled, so a later render/resume never has to replay repair
    logic, just load the result verbatim). None (stage must rerun) if
    missing/unparseable/wrong-shape, from a different source, its
    fingerprint doesn't match THIS call's already-validated media (see
    _load_scored_checkpoint's docstring -- same reasoning), or if any
    referenced clip mp4 no longer exists on disk (the clips/ artifact half
    of this checkpoint)."""
    path = _cuts_checkpoint_path(out_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return _discard(path, "checkpoint is valid JSON but not an object")
    if data.get("version") != CHECKPOINT_VERSION or data.get("source") != source:
        return None
    if data.get("fingerprint") != fingerprint:
        return _discard(path, "source content changed since this checkpoint was written")
    entries = data.get("clips")
    if not isinstance(entries, list):
        return None

    results = []
    for entry in entries:
        try:
            mp4 = Path(entry["paths"]["mp4"]) if entry["paths"].get("mp4") else None
            if mp4 is not None and not mp4.exists():
                return None
            results.append(_clip_result_from_entry(entry))
        except (KeyError, TypeError):
            return None
    return results, entries


def _write_cuts_checkpoint(out_dir: Path, source: str, fingerprint: str, entries: list[dict]) -> None:
    data = {"version": CHECKPOINT_VERSION, "source": source, "fingerprint": fingerprint, "clips": entries}
    _cuts_checkpoint_path(out_dir).write_text(json.dumps(data, indent=2))


# --- per-clip processing (surgeon -> hook -> render -> qa -> repair) -------


def _process_clips(
    keepers: list[Scored], media: SourceMedia, index, out_dir: Path, log: AgentLog
) -> tuple[list[ClipResult], list[dict]]:
    results: list[ClipResult] = []
    entries: list[dict] = []
    for i, scored in enumerate(keepers, start=1):
        candidate = scored.candidate
        clip_dir = out_dir / f"clip_{i:03d}"
        cut = surgeon_refine(candidate, index, log)
        hook = hooks.write(cut, index, log)
        mp4, thumb = render_clip(media.video, cut, index, hook, DEFAULT_STYLE, clip_dir)
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
            mp4, thumb = render_clip(media.video, cut, index, hook, DEFAULT_STYLE, clip_dir)
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
            dropped_reason=dropped_reason, repairs=repairs,
        )
        results.append(result)
        entries.append(_clip_entry(i, candidate, cut, scored, hook, report, repairs, dropped_reason, mp4, thumb))

    return results, entries


def _write_run_json(
    out_dir: Path, source: str, media: SourceMedia | None, entries: list[dict],
    log: AgentLog, timings: dict[str, float],
) -> None:
    data = {
        "version": RUN_SCHEMA_VERSION,
        "pipeline_version": _pipeline_version(),
        "source": {
            "input": source,
            "duration_s": media.info.duration_s if media else None,
            "fps": media.info.fps if media else None,
            "width": media.info.width if media else None,
            "height": media.info.height if media else None,
        },
        "duration_processed_s": media.info.duration_s if media else None,
        "agent_totals": log.totals(),
        "timings_s": timings,
        "clips": entries,
    }
    (out_dir / "run.json").write_text(json.dumps(data, indent=2))


def run(source: str | Path, out_dir: Path) -> list[ClipResult]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    source_id = str(source)

    log = AgentLog(out_dir / "agent_events.jsonl")
    timings: dict[str, float] = {}

    # Stage 1: ingest/media. Front door: local path passthrough or yt-dlp
    # download, caps enforced, yt-dlp failures mapped to typed codes -- if
    # a valid checkpoint exists for this exact source, skip network/
    # transcode entirely (str() rather than Path() so a URL's "//" doesn't
    # get collapsed by Path normalization).
    cached_media = _load_media_checkpoint(out_dir, source_id)
    if cached_media is not None:
        media = cached_media
        timings["ingest"] = 0.0
    else:
        t0 = time.monotonic()
        try:
            media = ingest.resolve(source_id, out_dir)
        except IngestError as exc:
            (out_dir / "run.json").write_text(
                json.dumps(
                    {
                        "version": RUN_SCHEMA_VERSION,
                        "error": {"code": exc.code, "message": exc.message},
                    },
                    indent=2,
                )
            )
            return []
        _write_media_checkpoint(out_dir, source_id, media)
        timings["ingest"] = time.monotonic() - t0

    # This call's validated content identity -- computed once, off the NOW-
    # validated `media` (whether reused or freshly resolved this call), and
    # threaded into every later stage's checkpoint check. That's what lets
    # scored.json/cuts.json catch a content swap even though their own
    # `source` string still matches: their fingerprint won't match media's.
    fingerprint = _source_fingerprint(media.video)

    # Stage 2: signals (transcribe + full signal index). Only consulted
    # when media was ITSELF reused this call -- a freshly (re)resolved
    # media means the source changed or the checkpoint was stale, so any
    # signals.json on disk is presumed stale too and gets rebuilt.
    cached_index = _load_signals_checkpoint(out_dir) if cached_media is not None else None
    if cached_index is not None:
        index = cached_index
        timings["signals"] = 0.0
    else:
        t0 = time.monotonic()
        index = build_signal_index(media, out_dir)
        save_signal_index(index, out_dir / "signals.json")
        timings["signals"] = time.monotonic() - t0

    if not index.words:
        _write_run_json(out_dir, source_id, media, [], log, timings)
        return []

    # Stage 3: crew (Scout<->Critic bounded debate -> scored keepers).
    cached_keepers = _load_scored_checkpoint(out_dir, source_id, fingerprint)
    if cached_keepers is not None:
        keepers = cached_keepers[:MAX_CLIPS]
        timings["crew"] = 0.0
    else:
        t0 = time.monotonic()
        # ponytail: render cap 4, lift when Modal parallel -- run_crew
        # already targets 5-8 keepers (fewer fine) and guarantees a non-
        # empty, best-effort list even on quiet content; this just caps
        # what we render.
        keepers = run_crew(index, log)[:MAX_CLIPS]
        _write_scored_checkpoint(out_dir, source_id, fingerprint, keepers)
        timings["crew"] = time.monotonic() - t0

    # Stage 4: per-clip surgeon -> hook -> render -> qa -> repair.
    cached_cuts = _load_cuts_checkpoint(out_dir, source_id, fingerprint)
    if cached_cuts is not None:
        results, entries = cached_cuts
        timings["render"] = 0.0
    else:
        t0 = time.monotonic()
        results, entries = _process_clips(keepers, media, index, out_dir, log)
        _write_cuts_checkpoint(out_dir, source_id, fingerprint, entries)
        timings["render"] = time.monotonic() - t0

    _write_run_json(out_dir, source_id, media, entries, log, timings)
    return results


def render_style(workdir: Path, style: str) -> list[ClipResult]:
    """Re-render every clip persisted under `workdir` (a prior run()'s
    out_dir) with a new caption `style`, from cuts.json + signals.json
    alone -- no re-transcription, no crew, no LLM calls anywhere (qa.check
    is pure code). Writes clips-<style>/clip_NNN/ + a sibling
    run-<style>.json; the original clips/ + run.json are untouched, so
    switching styles never destroys the first render.

    No repair loop here: cuts.json already holds the FINAL, repair-settled
    cut for each clip, and a caption-style change can't move WORD_CLIP/
    ALIGN/DUR outcomes (those depend only on cut boundaries, unchanged) --
    if RES/LUFS/BLACK/FROZEN somehow still fails on the restyled render,
    it's reported via qa/dropped_reason same as a first-pass failure, just
    without a retry loop burning a second re-render for a style switch."""
    if style not in _PRESETS:
        raise ValueError(f"unknown style {style!r} -- valid styles: {sorted(_PRESETS)}")
    workdir = Path(workdir)
    index = load_signal_index(workdir / "signals.json")
    media_data = json.loads((workdir / "media.json").read_text())
    video = Path(media_data["video"])
    cuts_data = json.loads((workdir / "cuts.json").read_text())

    out_root = workdir / f"clips-{style}"
    results: list[ClipResult] = []
    entries: list[dict] = []
    for entry in cuts_data["clips"]:
        i = entry["index"]
        candidate = _candidate_from_json(entry["candidate"])
        cut = _cut_from_json(entry["cut"])
        hook = _hook_from_json(entry.get("hook"))
        score = _scored_from_json(candidate, entry["score"]) if entry.get("score") is not None else None

        clip_dir = out_root / f"clip_{i:03d}"
        mp4, thumb = render_clip(video, cut, index, hook, style, clip_dir)
        report = qa.check(mp4, cut, index, hook=hook)
        dropped_reason = "; ".join(f.code for f in report.failures) if not report.passed else None
        repairs = entry.get("repairs", [])

        results.append(
            ClipResult(
                mp4=mp4, thumb=thumb, cut=cut, score=score, hook=hook, qa=report,
                dropped_reason=dropped_reason, repairs=repairs,
            )
        )
        entries.append(_clip_entry(i, candidate, cut, score, hook, report, repairs, dropped_reason, mp4, thumb))

    data = {
        "version": RUN_SCHEMA_VERSION,
        "pipeline_version": _pipeline_version(),
        "style": style,
        "clips": entries,
    }
    (workdir / f"run-{style}.json").write_text(json.dumps(data, indent=2))
    return results
