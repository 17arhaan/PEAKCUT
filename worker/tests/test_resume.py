"""T17: stage checkpoint/resume, style re-render, and the final run.json
contract -- the Modal-retry story (spec Sec7) proven locally, plus the
"why this clip" data contract (spec Sec5/Sec6) the future web app consumes.

`base_run` is module-scoped (one real pipeline run against the real
talking-head fixture, ~seconds of whisper+ffmpeg work) and shared read-only
by the schema-contract and style-re-render tests below; the kill-and-resume
test needs to MUTATE checkpoints so it runs its own independent pipeline
run in its own tmp_path.
"""

import json
import shutil
from pathlib import Path

import pytest

from conftest import fixture
from shorts.pipeline import (
    _clip_entry,
    _load_cuts_checkpoint,
    _load_media_checkpoint,
    _load_scored_checkpoint,
    _write_cuts_checkpoint,
    _write_media_checkpoint,
    _write_scored_checkpoint,
    render_style,
    run,
)
from shorts.types import Candidate, Cut, MediaInfo, Scored, SourceMedia

_REQUIRED_TOP_LEVEL = {
    "version", "pipeline_version", "source", "duration_processed_s",
    "agent_totals", "timings_s", "clips",
}
_REQUIRED_CLIP_KEYS = {
    "index", "candidate", "cut", "score", "hook", "qa", "repairs",
    "dropped_reason", "paths",
}


@pytest.fixture(scope="module")
def base_run(tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("resume_base")
    results = run(fixture("real_talking_head.mp4"), out_dir)
    return out_dir, results


def test_run_json_schema_contract(base_run):
    """Every field the final run.json contract promises (spec Sec5/Sec6/
    Sec11) is present on a real (non-mocked) run: source info, duration
    processed, per-agent token/cost totals, pipeline version, per-stage
    timings, and per-clip candidate window / cut / score-with-evidence /
    hook / qa / repairs / paths."""
    out_dir, results = base_run
    assert results  # sanity: the fixture actually produced clips

    run_json = json.loads((out_dir / "run.json").read_text())

    missing_top = _REQUIRED_TOP_LEVEL - run_json.keys()
    assert not missing_top, f"run.json missing top-level keys: {missing_top}"

    assert run_json["source"]["input"] == str(fixture("real_talking_head.mp4"))
    assert run_json["duration_processed_s"] > 0
    assert isinstance(run_json["agent_totals"], dict)
    assert set(run_json["timings_s"]) >= {"ingest", "signals", "crew", "render"}
    assert all(v >= 0 for v in run_json["timings_s"].values())

    clips = run_json["clips"]
    assert clips, "expected at least one clip entry"
    for clip in clips:
        missing = _REQUIRED_CLIP_KEYS - clip.keys()
        assert not missing, f"clip entry missing keys: {missing}"

        assert {"t0", "t1", "source"} <= clip["candidate"].keys()
        assert set(clip["cut"]) == {"t0", "t1", "payoff_word_i"}
        assert set(clip["paths"]) == {"mp4", "thumb"}
        assert set(clip["hook"]) == {"title", "captions"}
        assert set(clip["qa"]) == {"passed", "failures"}

        score = clip["score"]
        assert score is not None
        assert set(score) == {"total", "verdict", "components"}
        for comp in score["components"].values():
            assert set(comp) == {"score", "evidence"}
            for ev in comp["evidence"]:
                assert {"kind", "t", "value"} <= ev.keys()

        assert isinstance(clip["repairs"], list)


def test_render_style_reuses_checkpoints_without_llm_or_retranscription(base_run):
    """`shorts render --from <workdir> --style s2` (pipeline.render_style)
    re-renders from persisted cuts.json/signals.json alone: no
    re-transcription (signals.json untouched) and no LLM/crew calls
    (agent_events.jsonl byte-for-byte unchanged -- render_style never even
    opens an AgentLog)."""
    out_dir, _ = base_run
    signals_path = out_dir / "signals.json"
    events_path = out_dir / "agent_events.jsonl"
    signals_mtime_before = signals_path.stat().st_mtime
    events_before = events_path.read_text()

    results = render_style(out_dir, "s2")

    assert results
    assert all(r.mp4 is not None and r.mp4.exists() for r in results)
    assert (out_dir / "clips-s2").is_dir()
    assert (out_dir / "run-s2.json").exists()

    # original clips/run.json untouched
    assert (out_dir / "run.json").exists()

    assert signals_path.stat().st_mtime == signals_mtime_before
    assert events_path.read_text() == events_before

    style_json = json.loads((out_dir / "run-s2.json").read_text())
    assert style_json["style"] == "s2"
    assert style_json["clips"]
    for clip in style_json["clips"]:
        assert clip["paths"]["mp4"] is not None
        assert "clips-s2" in clip["paths"]["mp4"]


def test_resume_skips_signals_stage_and_reruns_crew(tmp_path):
    """Kill-and-resume: delete scored.json and every later artifact
    (cuts.json, clip_NNN/ dirs), then rerun with the SAME out_dir. The
    ingest/signals stage must be skipped entirely (signals.json mtime
    unchanged -- no re-transcription), while the crew stage must re-run
    (new agent_events.jsonl activity) and produce a schema-identical final
    run.json."""
    out_dir = tmp_path
    run(fixture("real_talking_head.mp4"), out_dir)

    signals_mtime_before = (out_dir / "signals.json").stat().st_mtime
    events_before = (out_dir / "agent_events.jsonl").read_text()

    (out_dir / "scored.json").unlink()
    (out_dir / "cuts.json").unlink()
    for clip_dir in sorted(out_dir.glob("clip_*")):
        shutil.rmtree(clip_dir)

    results2 = run(fixture("real_talking_head.mp4"), out_dir)

    # signals stage skipped: file untouched.
    assert (out_dir / "signals.json").stat().st_mtime == signals_mtime_before

    # crew stage re-ran: new activity appended to the log.
    events_after = (out_dir / "agent_events.jsonl").read_text()
    assert len(events_after) > len(events_before)
    assert events_after.startswith(events_before)

    assert results2
    run_json = json.loads((out_dir / "run.json").read_text())
    assert run_json["timings_s"]["ingest"] == 0.0
    assert run_json["timings_s"]["signals"] == 0.0
    assert run_json["clips"]
    for clip in run_json["clips"]:
        missing = _REQUIRED_CLIP_KEYS - clip.keys()
        assert not missing


def test_resume_is_full_no_op_when_nothing_deleted(tmp_path):
    """Re-running against a fully-intact out_dir must skip every stage --
    including crew/cuts -- and reproduce byte-identical clip records."""
    out_dir = tmp_path
    run(fixture("real_talking_head.mp4"), out_dir)
    run_json_before = json.loads((out_dir / "run.json").read_text())
    events_before = (out_dir / "agent_events.jsonl").read_text()

    run(fixture("real_talking_head.mp4"), out_dir)

    events_after = (out_dir / "agent_events.jsonl").read_text()
    assert events_after == events_before  # no stage re-ran -- no new log activity

    run_json_after = json.loads((out_dir / "run.json").read_text())
    assert run_json_after["timings_s"] == {
        "ingest": 0.0, "signals": 0.0, "crew": 0.0, "render": 0.0,
    }
    assert run_json_after["clips"] == run_json_before["clips"]


# --- source fingerprint (review finding 1) + tolerant loaders (finding 2) --
# Unit-level: no whisper/ffmpeg, checkpoint loaders exercised directly --
# per the task brief, the fast path is preferred over a second full
# pipeline run just to prove content-swap detection.


def _fake_media(tmp_path, video_bytes: bytes) -> tuple[SourceMedia, Path]:
    video = tmp_path / "src.mp4"
    video.write_bytes(video_bytes)
    wav = tmp_path / "audio.wav"
    wav.write_bytes(b"wav")
    media = SourceMedia(video=video, wav16k=wav, info=MediaInfo(duration_s=10.0, fps=30.0, width=1920, height=1080))
    return media, video


def test_media_checkpoint_discards_on_content_swap(tmp_path, capsys):
    """A media.json checkpoint written against one file's content must be
    discarded (None -- stage regenerates) once different content lands at
    the SAME source path, even though the source string is unchanged."""
    media, video = _fake_media(tmp_path, b"a" * 100)
    _write_media_checkpoint(tmp_path, str(video), media)

    assert _load_media_checkpoint(tmp_path, str(video)) is not None

    video.write_bytes(b"b" * 999)  # different content, same path
    assert _load_media_checkpoint(tmp_path, str(video)) is None
    assert "discarding media.json" in capsys.readouterr().out


@pytest.mark.parametrize("bad_json", ["null", "[]", "42"])
def test_media_checkpoint_tolerates_wrong_shape(tmp_path, bad_json):
    (tmp_path / "media.json").write_text(bad_json)
    assert _load_media_checkpoint(tmp_path, "some-source") is None


@pytest.mark.parametrize("bad_json", ["null", "[]", "42"])
def test_scored_checkpoint_tolerates_wrong_shape(tmp_path, bad_json):
    (tmp_path / "scored.json").write_text(bad_json)
    assert _load_scored_checkpoint(tmp_path, "some-source", "fp") is None


@pytest.mark.parametrize("bad_json", ["null", "[]", "42"])
def test_cuts_checkpoint_tolerates_wrong_shape(tmp_path, bad_json):
    (tmp_path / "cuts.json").write_text(bad_json)
    assert _load_cuts_checkpoint(tmp_path, "some-source", "fp") is None


def test_scored_checkpoint_discards_on_fingerprint_mismatch(tmp_path):
    """scored.json carries the same content fingerprint as media.json --
    even though its own `source` string still matches, a fingerprint that
    no longer matches THIS call's validated media (e.g. media.json itself
    already caught a content swap and regenerated) discards it too."""
    candidate = Candidate(t0=0.0, t1=5.0, source="test", evidence=[])
    scored = Scored(candidate=candidate, total=10, components={}, verdict="keep")
    _write_scored_checkpoint(tmp_path, "src", "fp-old", [scored])

    assert _load_scored_checkpoint(tmp_path, "src", "fp-old") is not None
    assert _load_scored_checkpoint(tmp_path, "src", "fp-new") is None


def test_cuts_checkpoint_discards_on_fingerprint_mismatch(tmp_path):
    candidate = Candidate(t0=0.0, t1=5.0, source="test", evidence=[])
    cut = Cut(t0=0.0, t1=5.0)
    entry = _clip_entry(1, candidate, cut, None, None, None, [], None, None, None)
    _write_cuts_checkpoint(tmp_path, "src", "fp-old", [entry])

    assert _load_cuts_checkpoint(tmp_path, "src", "fp-old") is not None
    assert _load_cuts_checkpoint(tmp_path, "src", "fp-new") is None
