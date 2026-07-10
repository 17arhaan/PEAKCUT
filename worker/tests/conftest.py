"""Shared test helpers: fixture path lookup + span comparator.

Fixtures themselves are built once by `scripts/make_fixtures.py` and
committed to `tests/fixtures/`; this module never generates them.
"""

import os
from pathlib import Path

os.environ.setdefault("SHORTS_WHISPER_MODEL", "tiny")

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def fixture(name: str) -> Path:
    """Path to a committed test fixture under tests/fixtures/."""
    path = FIXTURES_DIR / name
    if not path.exists():
        raise FileNotFoundError(
            f"fixture {name!r} not found at {path} -- run scripts/make_fixtures.py"
        )
    return path


def approx_spans(a, b, tol_s: float) -> bool:
    """True if a and b (each a (t0, t1) tuple, or an object with .t0/.t1)
    have matching start and end within tol_s seconds."""
    a0, a1 = (a.t0, a.t1) if hasattr(a, "t0") else (a[0], a[1])
    b0, b1 = (b.t0, b.t1) if hasattr(b, "t0") else (b[0], b[1])
    return abs(a0 - b0) <= tol_s and abs(a1 - b1) <= tol_s
