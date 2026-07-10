"""Walking-skeleton end-to-end regression guard: video in, captioned 9:16
clip out. This is the permanent regression test for the whole pipeline --
later tasks upgrade individual stages but must keep this green."""

from conftest import fixture
from shorts.ffmpeg import probe
from shorts.pipeline import run


def test_e2e_produces_valid_clip(tmp_path):
    results = run(fixture("real_talking_head.mp4"), tmp_path)
    ok = [r for r in results if r.mp4]
    assert len(ok) >= 2
    info = probe(ok[0].mp4)
    assert (info.width, info.height) == (1080, 1920)
    assert 5 <= info.duration_s <= 65
    assert (tmp_path / "run.json").exists()
