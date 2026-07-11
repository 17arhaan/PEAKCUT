"""Unit tests for pipeline._fallback_candidates: hand-built tiny SignalIndex
objects, no real media/rendering -- exercises the speech-anchored window
placement and its two degenerate cases directly.

Also covers the T8 QA-gate pipeline wiring (partial success): a real e2e
run against real_talking_head.mp4, with qa.check monkeypatched to force
exactly one clip to fail -- deterministic and fast, since the actual QA
check logic (which codes fire for which corruption) is covered by
test_qa.py, not here."""

import json

from shorts import ingest, qa
from shorts.pipeline import _fallback_candidates, run
from shorts.types import Curve, MediaInfo, QAFail, QAReport, SignalIndex, Span

from conftest import fixture


def _mk_index(**overrides) -> SignalIndex:
    defaults = dict(
        version=1,
        media=MediaInfo(duration_s=60.0, fps=30.0, width=1920, height=1080),
        language="en",
        words=[],
        fillers=[],
        speech=[],
        silences=[],
        energy=Curve(hop_s=0.05, values=[]),
        peaks=[],
        rate=Curve(hop_s=1.0, values=[]),
        pitch=Curve(hop_s=1.0, values=[]),
        surges=[],
        monotone=[],
        events=[],
        scenes=[],
        faces=[],
        motion=Curve(hop_s=0.5, values=[]),
        defects_black=[],
        defects_frozen=[],
    )
    defaults.update(overrides)
    return SignalIndex(**defaults)


def test_fallback_windows_anchor_to_speech_spans():
    """Speech only occupies two short spans out of a 200s video (mostly
    silence) -- fallback windows should land inside/around the speech, not
    spread evenly across the silent majority of the timeline."""
    idx = _mk_index(
        media=MediaInfo(duration_s=200.0, fps=30.0, width=1920, height=1080),
        speech=[Span(t0=10.0, t1=20.0), Span(t0=150.0, t1=160.0)],
    )

    candidates = _fallback_candidates(idx, 2)

    assert len(candidates) == 2
    # each candidate's window should overlap one of the two speech spans,
    # not fall in the silent gap between them.
    for c in candidates:
        overlaps_speech = any(c.t0 < s.t1 and c.t1 > s.t0 for s in idx.speech)
        assert overlaps_speech
        assert c.source == "fallback"
        assert c.evidence == []


def test_fallback_falls_back_to_duration_spacing_when_no_speech():
    """No speech at all (e.g. a silent clip, or a hand-built index missing
    VAD output) -- nothing to anchor to, so fallback should degrade to the
    old evenly-spaced-over-duration behavior instead of crashing/collapsing."""
    idx = _mk_index(media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080), speech=[])

    candidates = _fallback_candidates(idx, 4)

    assert len(candidates) == 4
    # roughly evenly spread across the duration
    starts = sorted(c.t0 for c in candidates)
    assert starts[0] < 30.0
    assert starts[-1] > 60.0


def test_fallback_drops_near_duplicate_windows_on_very_short_video():
    """duration < n*10s: evenly-spaced target midpoints are closer together
    than the minimum window length, so once each window is clamped/shifted
    to fit inside the video, several would be near-identical -- those
    extras should be dropped rather than emitted as duplicate clips."""
    idx = _mk_index(
        media=MediaInfo(duration_s=15.0, fps=30.0, width=1920, height=1080),
        speech=[Span(t0=0.0, t1=15.0)],
    )

    candidates = _fallback_candidates(idx, 4)

    assert 1 <= len(candidates) < 4
    # whatever survives must be pairwise non-near-duplicate.
    for i, a in enumerate(candidates):
        for b in candidates[i + 1 :]:
            inter = max(0.0, min(a.t1, b.t1) - max(a.t0, b.t0))
            union = (a.t1 - a.t0) + (b.t1 - b.t0) - inter
            iou = inter / union if union > 0 else 0.0
            assert iou <= 0.5


def test_run_drops_qa_failed_clip_but_run_still_succeeds(tmp_path, monkeypatch):
    """A QA failure on one clip must not crash the run -- that clip is kept
    on disk but marked dropped_reason, and the run still produces its other
    clips (spec Sec7: partial success is success). qa.check is fully
    monkeypatched (deterministic pass/fail by call order) rather than
    delegated to the real check -- real QA correctness (which codes fire
    for which corruption) is test_qa.py's job; a real render's WORD_CLIP/
    ALIGN outcome on heuristic (non-word-aligned) cuts is itself
    real/legitimate gate behavior and not deterministic enough to assert
    on here without coupling this wiring test to scout's cut placement."""
    calls = {"n": 0}

    def fake_check(mp4, cut, idx, hook=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return QAReport(
                passed=False, failures=[QAFail(code="BLACK", detail="forced", route_to="drop")]
            )
        return QAReport(passed=True, failures=[])

    monkeypatch.setattr(qa, "check", fake_check)

    results = run(fixture("real_talking_head.mp4"), tmp_path)

    dropped = [r for r in results if r.dropped_reason]
    kept = [r for r in results if not r.dropped_reason]
    assert len(dropped) == 1
    assert dropped[0].dropped_reason == "BLACK"
    assert dropped[0].mp4.exists()  # render kept on disk even though dropped
    assert len(kept) >= 1  # partial success: the rest still shipped

    run_json = json.loads((tmp_path / "run.json").read_text())
    assert any(not e["qa"]["passed"] and e["dropped_reason"] == "BLACK" for e in run_json)
    assert any(e["qa"]["passed"] and e["dropped_reason"] is None for e in run_json)


def test_run_ingest_error_writes_failed_run_json_without_crashing(tmp_path, monkeypatch):
    """An IngestError from the front door (T16) must not propagate as a
    crash -- the pipeline catches it, writes a failed run.json carrying the
    typed code + message, and returns an empty result list. resolve() is
    fully monkeypatched here -- ingest.py's own error-mapping correctness is
    test_ingest.py's job; this is purely the pipeline wiring."""

    def fake_resolve(source, workdir):
        raise ingest.IngestError("GEO_BLOCKED", "This video isn't available in your region.")

    monkeypatch.setattr(ingest, "resolve", fake_resolve)

    results = run("https://example.com/watch?v=blocked", tmp_path)

    assert results == []
    run_json = json.loads((tmp_path / "run.json").read_text())
    assert run_json == {
        "error": {"code": "GEO_BLOCKED", "message": "This video isn't available in your region."}
    }
