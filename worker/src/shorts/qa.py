"""qa.check: the pure-code QA gate. Inspects a rendered clip and the source
SignalIndex it was cut from; no LLM anywhere in this module.

Six checks. Each failure carries a route_to telling the pipeline's repair
loop (T14) where to send it: WORD_CLIP/ALIGN are cut-caused, so they route
back to "surgeon" for a deterministic re-refine; RES/LUFS/BLACK/FROZEN are
render-caused (or, for BLACK/FROZEN, may be genuine source-content defects
a re-render can't fix -- that's expected, the repair loop bounds the
retries and drops). DUR isn't in the repair map -- surgeon.refine already
clamps every cut to [5, 90]s, so a DUR failure post-refine is an anomaly,
not a repairable routing case; it drops immediately.
"""

import re
import subprocess
from pathlib import Path

from shorts.ffmpeg import probe
from shorts.signals.index import words_in
from shorts.signals.video import detect_defects
from shorts.types import Cut, Hook, QAFail, QAReport, SignalIndex

TARGET_W, TARGET_H = 1080, 1920
_LUFS_TARGET = -14.0
_LUFS_TOLERANCE = 1.0
_SAFE_AREA_MAX_CHARS = 40
_SAFE_AREA_WIDTH_FRAC = 0.9
# ponytail: char-width heuristic, real text measurement if fonts change --
# picked so that _SAFE_AREA_MAX_CHARS characters always stays under
# _SAFE_AREA_WIDTH_FRAC of the frame (40 * 20 = 800px < 0.9*1080 = 972px),
# so hooks.py's fallback path (hard-capped at _SAFE_AREA_MAX_CHARS) is
# guaranteed to pass this check purely by the char-length check.
_SAFE_AREA_AVG_CHAR_WIDTH_PX = 20.0
# PLAN AMENDMENT (decision 2026-07-11, recorded in signals/align.py): the
# alignment quality gate was re-anchored to p95<=300ms, not the plan's
# original 100ms -- this check uses the same 300ms bound.
_ALIGN_P95_MAX_MS = 300.0
_MIN_DUR_S = 5.0
_MAX_DUR_S = 90.0

# code -> stage the pipeline's repair loop routes a failure to.
_ROUTE = {
    "RES": "render",
    "LUFS": "render",
    "BLACK": "render",
    "FROZEN": "render",
    "WORD_CLIP": "surgeon",
    "ALIGN": "surgeon",
    "DUR": "drop",
    # A bad hook surviving hooks.write's constraint enforcement + re-ask +
    # (SAFE_AREA-guaranteed) fallback is an anomaly, not a repairable case.
    "SAFE_AREA": "drop",
}

_EBUR128_I_RE = re.compile(r"I:\s*(-?[\d.]+) LUFS")


def _measure_lufs(mp4: Path) -> float:
    """Integrated loudness (LUFS) of the whole output file via ffmpeg's
    ebur128 filter, parsed off its stderr Summary block (same "filter logs
    to stderr, not stdout" quirk as loudnorm/blackdetect/freezedetect
    elsewhere in this codebase)."""
    proc = subprocess.run(
        ["ffmpeg", "-i", str(mp4), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True, check=False,
    )
    stderr = proc.stderr.decode("utf-8", errors="replace")
    summary = stderr.rsplit("Summary:", 1)[-1]
    match = _EBUR128_I_RE.search(summary)
    if not match:
        # ponytail: guard for very short/silent clips where ebur128 reports
        # "-inf LUFS" (no digits to match) or no Summary at all -- treat as
        # a hard LUFS failure rather than crashing.
        return float("-inf")
    return float(match.group(1))


def _check_res(width: int, height: int) -> QAFail | None:
    if (width, height) != (TARGET_W, TARGET_H):
        return QAFail(
            code="RES", detail=f"{width}x{height} != {TARGET_W}x{TARGET_H}", route_to=_ROUTE["RES"]
        )
    return None


def _check_dur(duration_s: float) -> QAFail | None:
    if duration_s < _MIN_DUR_S or duration_s > _MAX_DUR_S:
        return QAFail(
            code="DUR",
            detail=f"duration {duration_s:.2f}s outside [{_MIN_DUR_S}, {_MAX_DUR_S}]",
            route_to=_ROUTE["DUR"],
        )
    return None


def _check_lufs(mp4: Path) -> QAFail | None:
    lufs = _measure_lufs(mp4)
    if lufs < _LUFS_TARGET - _LUFS_TOLERANCE or lufs > _LUFS_TARGET + _LUFS_TOLERANCE:
        return QAFail(
            code="LUFS",
            detail=f"{lufs:.1f} LUFS outside {_LUFS_TARGET}+-{_LUFS_TOLERANCE}",
            route_to=_ROUTE["LUFS"],
        )
    return None


def _check_defects(mp4: Path) -> list[QAFail]:
    """Reruns the existing detect_defects (blackdetect/freezedetect) on the
    OUTPUT clip -- reused as-is, not duplicated, per the plan."""
    black, frozen = detect_defects(mp4)
    out: list[QAFail] = []
    if black:
        out.append(
            QAFail(
                code="BLACK",
                detail=f"{len(black)} black span(s): {black}",
                route_to=_ROUTE["BLACK"],
            )
        )
    if frozen:
        out.append(
            QAFail(
                code="FROZEN",
                detail=f"{len(frozen)} frozen span(s): {frozen}",
                route_to=_ROUTE["FROZEN"],
            )
        )
    return out


def _check_word_clip(cut: Cut, idx: SignalIndex) -> QAFail | None:
    """A word straddles a cut boundary if it starts before the boundary and
    ends after it. words_in(idx, t, t) with a zero-width [t, t) window
    returns exactly the words satisfying w.t0 < t < w.t1 -- reused here for
    both boundaries instead of re-deriving the straddle condition."""
    words = words_in(idx, cut.t0, cut.t0) + words_in(idx, cut.t1, cut.t1)
    if words:
        return QAFail(
            code="WORD_CLIP",
            detail=f"{len(words)} word(s) straddle a cut boundary: {[w.text for w in words]}",
            route_to=_ROUTE["WORD_CLIP"],
        )
    return None


def _check_align(cut: Cut, idx: SignalIndex) -> QAFail | None:
    """p95 align_err_ms of words inside the cut, English only (align.py's
    forced-aligner is en-only; align_err_ms is never populated for other
    languages, so this check would have nothing to measure). Words with
    align_err_ms=None (unalignable) are skipped."""
    if idx.language != "en":
        return None

    errs = sorted(
        w.align_err_ms for w in words_in(idx, cut.t0, cut.t1) if w.align_err_ms is not None
    )
    if not errs:
        return None

    p95 = errs[int(0.95 * (len(errs) - 1))]
    if p95 > _ALIGN_P95_MAX_MS:
        return QAFail(
            code="ALIGN",
            detail=f"p95 align_err_ms={p95:.1f} > {_ALIGN_P95_MAX_MS}",
            route_to=_ROUTE["ALIGN"],
        )
    return None


def _check_safe_area(hook: Hook | None, width: int) -> QAFail | None:
    """The hook title must fit the top safe area: at most
    _SAFE_AREA_MAX_CHARS characters, and its estimated rendered width (char
    count * the heuristic avg glyph width) must not overflow
    _SAFE_AREA_WIDTH_FRAC of the frame. No-op if there's no hook at all."""
    if hook is None:
        return None
    title = hook.title
    if len(title) > _SAFE_AREA_MAX_CHARS:
        return QAFail(
            code="SAFE_AREA",
            detail=f"hook title is {len(title)} chars, max {_SAFE_AREA_MAX_CHARS}",
            route_to=_ROUTE["SAFE_AREA"],
        )
    estimated_width = len(title) * _SAFE_AREA_AVG_CHAR_WIDTH_PX
    max_width = _SAFE_AREA_WIDTH_FRAC * width
    if estimated_width > max_width:
        return QAFail(
            code="SAFE_AREA",
            detail=f"hook title estimated width {estimated_width:.0f}px > {max_width:.0f}px "
            f"({_SAFE_AREA_WIDTH_FRAC * 100:.0f}% of {width}px frame)",
            route_to=_ROUTE["SAFE_AREA"],
        )
    return None


def check(mp4: Path, cut: Cut, idx: SignalIndex, hook: Hook | None = None) -> QAReport:
    """Run every QA check against a rendered clip. mp4/RES/LUFS/BLACK/FROZEN/
    DUR inspect the rendered output file itself; WORD_CLIP/ALIGN inspect
    `cut` against the source SignalIndex's transcript; SAFE_AREA inspects
    `hook`'s title (skipped entirely if `hook` is None)."""
    info = probe(mp4)

    failures = [
        f
        for f in (
            _check_res(info.width, info.height),
            _check_dur(info.duration_s),
            _check_lufs(mp4),
            _check_word_clip(cut, idx),
            _check_align(cut, idx),
            _check_safe_area(hook, info.width),
        )
        if f is not None
    ]
    failures.extend(_check_defects(mp4))

    return QAReport(passed=not failures, failures=failures)
