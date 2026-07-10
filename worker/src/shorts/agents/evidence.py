"""Evidence gate: rejects LLM-emitted Claims that don't cite real measured
signals. This is the product's differentiator -- an LLM verdict is only as
good as the claims it's built on, so every claim is checked against the
SignalIndex in plain Python before it's allowed to influence a score.

Per-kind resolution table (task-10 brief, verbatim):
    energy_peak    -- a Peak within +/-0.5s of t AND |sigma-value| <= 0.5
    laughter/applause -- an AudioEvent of that label overlapping t +/-1.0s
    rate_surge     -- a surge Span containing t
    silence        -- a silence Span within +/-0.5s of t
    scene_stable   -- scene_span(t) exists with duration >= 15s
    quote          -- value (str) is a substring of words_in(t-1, t+len/4)
                       text, case/punctuation-insensitive
    anything else  -- Violation("unknown kind")
All claims must also fall inside `window` +/-2s.
"""

import string
from dataclasses import dataclass

from shorts.signals.index import events_in, nearest_silence, peaks_in, scene_span, words_in
from shorts.types import Claim, SignalIndex, Span

_PEAK_T_TOL_S = 0.5
_PEAK_SIGMA_TOL = 0.5
_EVENT_T_TOL_S = 1.0
_SILENCE_T_TOL_S = 0.5
_SCENE_MIN_LEN_S = 15.0
_WINDOW_TOL_S = 2.0
_QUOTE_LEAD_S = 1.0
# ponytail: chars/4 is a reading-speed heuristic (~4 chars/sec of speech),
# not a measured constant -- it just needs to be "long enough" to cover a
# spoken quote of that length, and the brief specifies it literally.
_QUOTE_CHARS_PER_S = 4.0


@dataclass(frozen=True)
class Violation:
    """A Claim that the gate rejected, with a reason specific enough to
    re-prompt the LLM with (kept out of types.py -- this is gate-internal,
    not part of the shared Claim/Candidate vocabulary)."""

    claim: Claim
    reason: str


def _normalize(text: str) -> str:
    text = text.lower()
    text = text.translate(str.maketrans("", "", string.punctuation))
    return " ".join(text.split())


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _resolve_energy_peak(claim: Claim, idx: SignalIndex) -> Violation | None:
    if not _is_number(claim.value):
        return Violation(claim, "bad value type")
    nearby = peaks_in(idx, claim.t - _PEAK_T_TOL_S, claim.t + _PEAK_T_TOL_S)
    if any(abs(p.sigma - claim.value) <= _PEAK_SIGMA_TOL for p in nearby):
        return None
    if not idx.peaks:
        return Violation(
            claim,
            f"no energy peak within {_PEAK_T_TOL_S}s of t={claim.t}; index has no peaks",
        )
    nearest = min(idx.peaks, key=lambda p: abs(p.t - claim.t))
    return Violation(
        claim,
        f"no energy peak within {_PEAK_T_TOL_S}s of t={claim.t} matching "
        f"sigma={claim.value}; nearest is t={nearest.t} sigma={nearest.sigma}",
    )


def _resolve_event(label: str):
    def resolver(claim: Claim, idx: SignalIndex) -> Violation | None:
        matches = events_in(idx, claim.t - _EVENT_T_TOL_S, claim.t + _EVENT_T_TOL_S, label=label)
        if matches:
            return None
        all_of_label = [e for e in idx.events if e.label == label]
        if not all_of_label:
            return Violation(
                claim,
                f"no {label} event within {_EVENT_T_TOL_S}s of t={claim.t}; "
                f"index has no {label} events",
            )
        nearest = min(all_of_label, key=lambda e: min(abs(e.t0 - claim.t), abs(e.t1 - claim.t)))
        return Violation(
            claim,
            f"no {label} event within {_EVENT_T_TOL_S}s of t={claim.t}; "
            f"nearest {label} is t=[{nearest.t0},{nearest.t1}]",
        )

    return resolver


def _resolve_rate_surge(claim: Claim, idx: SignalIndex) -> Violation | None:
    if any(s.t0 <= claim.t <= s.t1 for s in idx.surges):
        return None
    if not idx.surges:
        return Violation(claim, f"no rate surge contains t={claim.t}; index has no surges")
    nearest = min(idx.surges, key=lambda s: min(abs(s.t0 - claim.t), abs(s.t1 - claim.t)))
    return Violation(
        claim,
        f"no rate surge contains t={claim.t}; nearest surge is [{nearest.t0},{nearest.t1}]",
    )


def _resolve_silence(claim: Claim, idx: SignalIndex) -> Violation | None:
    nearest = nearest_silence(idx, claim.t)
    if nearest is None:
        return Violation(
            claim, f"no silence span within {_SILENCE_T_TOL_S}s of t={claim.t}; index has no silences"
        )
    dist = 0.0 if nearest.t0 <= claim.t <= nearest.t1 else min(
        abs(nearest.t0 - claim.t), abs(nearest.t1 - claim.t)
    )
    if dist <= _SILENCE_T_TOL_S:
        return None
    return Violation(
        claim,
        f"no silence span within {_SILENCE_T_TOL_S}s of t={claim.t}; "
        f"nearest is [{nearest.t0},{nearest.t1}]",
    )


def _resolve_scene_stable(claim: Claim, idx: SignalIndex) -> Violation | None:
    span = scene_span(idx, claim.t)
    if span is None:
        return Violation(claim, f"no scene span contains t={claim.t}")
    duration = span.t1 - span.t0
    if duration >= _SCENE_MIN_LEN_S:
        return None
    return Violation(
        claim,
        f"scene at t={claim.t} is only {duration:.1f}s, below {_SCENE_MIN_LEN_S}s minimum",
    )


def _resolve_quote(claim: Claim, idx: SignalIndex) -> Violation | None:
    if not isinstance(claim.value, str):
        return Violation(claim, "bad value type")
    t1 = claim.t + len(claim.value) / _QUOTE_CHARS_PER_S
    words = words_in(idx, claim.t - _QUOTE_LEAD_S, t1)
    haystack = _normalize(" ".join(w.text for w in words))
    needle = _normalize(claim.value)
    if needle and needle in haystack:
        return None
    return Violation(
        claim,
        f"quote {claim.value!r} not found in transcript t=[{claim.t - _QUOTE_LEAD_S:.1f},{t1:.1f}]",
    )


_RESOLVERS = {
    "energy_peak": _resolve_energy_peak,
    "laughter": _resolve_event("laughter"),
    "applause": _resolve_event("applause"),
    "rate_surge": _resolve_rate_surge,
    "silence": _resolve_silence,
    "scene_stable": _resolve_scene_stable,
    "quote": _resolve_quote,
}


def validate_claims(claims: list[Claim], idx: SignalIndex, window: Span) -> list[Violation]:
    """Validate every claim against `idx`; return one Violation per claim
    that fails to resolve (claims that pass are simply absent)."""
    violations = []
    for claim in claims:
        v = _validate_one(claim, idx, window)
        if v is not None:
            violations.append(v)
    return violations


def _validate_one(claim: Claim, idx: SignalIndex, window: Span) -> Violation | None:
    if not (window.t0 - _WINDOW_TOL_S <= claim.t <= window.t1 + _WINDOW_TOL_S):
        return Violation(
            claim,
            f"outside window [{window.t0}, {window.t1}] (+/-{_WINDOW_TOL_S}s): t={claim.t}",
        )
    resolver = _RESOLVERS.get(claim.kind)
    if resolver is None:
        return Violation(claim, "unknown kind")
    return resolver(claim, idx)
