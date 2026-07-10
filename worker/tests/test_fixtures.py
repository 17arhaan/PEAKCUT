"""Asserts the committed fixtures exist and match MANIFEST.json exactly.

The fixtures themselves are built once by `scripts/make_fixtures.py` and
committed; this test never regenerates them, it only verifies what's there.
"""

import hashlib
import json
from pathlib import Path

import pytest

from conftest import fixture
from shorts.ffmpeg import probe

MANIFEST_PATH = Path(__file__).parent / "fixtures" / "MANIFEST.json"
MANIFEST = json.loads(MANIFEST_PATH.read_text())


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", sorted(MANIFEST))
def test_fixture_matches_manifest(name):
    path = fixture(name)
    entry = MANIFEST[name]

    assert path.exists()
    assert abs(probe(path).duration_s - entry["duration_s"]) <= 0.5
    assert _sha256(path) == entry["sha256"]
