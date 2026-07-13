"""Uploader selection/idempotency logic only -- OAuth and the actual
videos.insert are monkeypatched out (network), so these run in the fast suite."""

import json

import shorts.publish.youtube as yt
from shorts.publish.youtube import publish_workdir_to_youtube


def _mk_workdir(tmp_path, n_clips=2):
    clips = []
    for i in range(1, n_clips + 1):
        clip_dir = tmp_path / f"clip_{i:03d}"
        clip_dir.mkdir()
        mp4 = clip_dir / "clip.mp4"
        mp4.write_bytes(b"fake-mp4")
        (clip_dir / "publish.json").write_text(
            json.dumps({"title": f"Clip {i} #Shorts", "privacyStatus": "unlisted"})
        )
        clips.append({"index": i, "dropped_reason": None, "paths": {"mp4": str(mp4)}})
    (tmp_path / "run.json").write_text(json.dumps({"clips": clips}))
    return tmp_path


def _stub_network(monkeypatch, uploaded: list):
    monkeypatch.setattr(yt, "_credentials", lambda *a, **k: object())
    monkeypatch.setattr(yt, "build", lambda *a, **k: object())

    def fake_upload(_youtube, mp4, meta, privacy):
        uploaded.append((mp4.parent.name, privacy))
        return f"vid_{mp4.parent.name}"

    monkeypatch.setattr(yt, "_upload_one", fake_upload)


def test_upload_writes_receipts_and_rerun_skips_them(tmp_path, monkeypatch):
    work = _mk_workdir(tmp_path)
    uploaded: list = []
    _stub_network(monkeypatch, uploaded)

    first = publish_workdir_to_youtube(work, client_secret=tmp_path / "cs.json")

    assert [name for name, _ in uploaded] == ["clip_001", "clip_002"]
    assert len(first) == 2
    receipt = json.loads((work / "clip_001" / "youtube.json").read_text())
    assert receipt["video_id"] == "vid_clip_001"
    assert receipt["url"] == "https://youtu.be/vid_clip_001"

    # re-run: every clip has a receipt now -> nothing uploads, nothing returned
    uploaded.clear()
    second = publish_workdir_to_youtube(work, client_secret=tmp_path / "cs.json")
    assert uploaded == []
    assert second == []


def test_limit_counts_only_new_uploads(tmp_path, monkeypatch):
    """--limit 1 on a workdir whose first clip is already receipted must upload
    the NEXT clip, not stop at the receipted one."""
    work = _mk_workdir(tmp_path)
    (work / "clip_001" / "youtube.json").write_text(json.dumps({"video_id": "already"}))
    uploaded: list = []
    _stub_network(monkeypatch, uploaded)

    results = publish_workdir_to_youtube(work, client_secret=tmp_path / "cs.json", limit=1)

    assert [name for name, _ in uploaded] == ["clip_002"]
    assert len(results) == 1


def test_dropped_and_receiptless_clips_are_skipped(tmp_path, monkeypatch):
    work = _mk_workdir(tmp_path)
    run = json.loads((work / "run.json").read_text())
    run["clips"][0]["dropped_reason"] = "BLACK"
    (work / "run.json").write_text(json.dumps(run))
    uploaded: list = []
    _stub_network(monkeypatch, uploaded)

    publish_workdir_to_youtube(work, client_secret=tmp_path / "cs.json")

    assert [name for name, _ in uploaded] == ["clip_002"]
