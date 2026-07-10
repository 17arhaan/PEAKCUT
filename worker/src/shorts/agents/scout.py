"""Heuristic Scout: signal-driven candidate-moment finder over a
SignalIndex. No LLM here -- three overlap rules over the raw signals each
propose candidate clip windows, and every candidate carries the Claims that
justify it (the evidence-gate vocabulary a later Critic task consumes).
"""

import math
import statistics

from shorts.signals.index import events_in, peaks_in
from shorts.types import Candidate, Claim, SignalIndex

MAX_CANDIDATES = 20
MIN_LEN_S = 10.0
MAX_LEN_S = 90.0

# rule (a): energy peak <-> rate surge proximity
_PEAK_SURGE_PROXIMITY_S = 5.0
_PEAK_SURGE_WINDOW_S = 20.0  # candidate is +/- this much around the pair

# rule (b): laughter/applause needs this much speech immediately before it
_LAUGH_LEADUP_SPEECH_S = 8.0
_LAUGH_LEADUP_WINDOW_S = 20.0  # candidate starts this long before the event
_LAUGH_TAIL_S = 3.0  # candidate ends this long after the event

# rule (c): minimum stable-scene length + the pitch-variance percentile bar
_SCENE_MIN_LEN_S = 20.0
_PITCH_VARIANCE_PERCENTILE_N = 10  # top decile == quantiles(n=10)'s last cut


def _iou(a: Candidate, b: Candidate) -> float:
    inter = max(0.0, min(a.t1, b.t1) - max(a.t0, b.t0))
    if inter <= 0.0:
        return 0.0
    union = (a.t1 - a.t0) + (b.t1 - b.t0) - inter
    return inter / union if union > 0 else 0.0


def _clamp_windows(t0: float, t1: float, duration: float) -> list[tuple[float, float]]:
    """Clamp a raw (t0, t1) window to [0, duration] and to a 10-90s length.
    Short windows are padded symmetrically (bounded by the video edges).
    Long windows are split into 2+ *equal-sized* chunks -- rather than
    fixed-90s chunks plus a short leftover tail, which could dip below
    MIN_LEN_S -- so a long stable span contributes several in-bounds
    candidates instead of losing its tail."""
    t0 = max(0.0, t0)
    t1 = min(duration, t1)
    if t1 <= t0:
        return []

    length = t1 - t0
    if length < MIN_LEN_S:
        pad = (MIN_LEN_S - length) / 2
        t0 = max(0.0, t0 - pad)
        t1 = min(duration, t1 + pad)
        return [(t0, t1)] if t1 > t0 else []

    if length <= MAX_LEN_S:
        return [(t0, t1)]

    n = math.ceil(length / MAX_LEN_S)
    chunk = length / n
    return [(t0 + i * chunk, t0 + (i + 1) * chunk) for i in range(n)]


def _rule_energy_rate(idx: SignalIndex) -> list[Candidate]:
    """(a) energy peak AND rate surge within 5s of each other -> candidate
    window +/-20s around the pair (centered on the peak, the sharper of the
    two signals in time). Surges have no query helper (there's no windowed
    lookup to reuse for "iterate every surge"), so that loop stays raw; the
    per-surge peak lookup goes through peaks_in, and among peaks in that
    +/-5s window we pick the one nearest the surge's midpoint rather than
    the first one found."""
    duration = idx.media.duration_s
    out = []
    for surge in idx.surges:
        window_peaks = peaks_in(
            idx,
            surge.t0 - _PEAK_SURGE_PROXIMITY_S,
            surge.t1 + _PEAK_SURGE_PROXIMITY_S,
        )
        if not window_peaks:
            continue
        surge_mid = (surge.t0 + surge.t1) / 2
        peak = min(window_peaks, key=lambda p: abs(p.t - surge_mid))
        evidence = [
            Claim(kind="energy_peak", t=peak.t, value=peak.sigma),
            Claim(kind="rate_surge", t=surge.t0),
        ]
        for t0, t1 in _clamp_windows(
            peak.t - _PEAK_SURGE_WINDOW_S, peak.t + _PEAK_SURGE_WINDOW_S, duration
        ):
            out.append(Candidate(t0=t0, t1=t1, source="rule_a_energy_rate", evidence=list(evidence)))
    return out


def _speech_seconds_in(idx: SignalIndex, t0: float, t1: float) -> float:
    return sum(max(0.0, min(s.t1, t1) - max(s.t0, t0)) for s in idx.speech)


def _rule_laughter(idx: SignalIndex) -> list[Candidate]:
    """(b) laughter/applause event with >=8s of speech before it ->
    candidate ending just after the event."""
    duration = idx.media.duration_s
    events = events_in(idx, 0.0, duration, label="laughter") + events_in(
        idx, 0.0, duration, label="applause"
    )
    events.sort(key=lambda e: e.t0)
    out = []
    for event in events:
        lead_speech = _speech_seconds_in(idx, event.t0 - _LAUGH_LEADUP_SPEECH_S, event.t0)
        if lead_speech < _LAUGH_LEADUP_SPEECH_S:
            continue
        evidence = [Claim(kind=event.label, t=event.t0, value=event.conf)]
        raw_t0 = event.t0 - _LAUGH_LEADUP_WINDOW_S
        raw_t1 = event.t1 + _LAUGH_TAIL_S
        for t0, t1 in _clamp_windows(raw_t0, raw_t1, duration):
            out.append(Candidate(t0=t0, t1=t1, source="rule_b_laughter", evidence=list(evidence)))
    return out


def _rule_scene_pitch(idx: SignalIndex) -> list[Candidate]:
    """(c) scene-stable span >=20s with top-decile pitch variance ->
    candidate on that span. "Top decile" is defined over the population of
    nonzero pitch.Curve buckets for this video (zero buckets mean "not
    enough voiced samples to measure", not "low variance" -- see
    audio.py:_pitch_variance_curve -- so they're excluded from the
    population, not just the winners)."""
    duration = idx.media.duration_s
    hop_s = idx.pitch.hop_s
    values = idx.pitch.values
    nonzero = [v for v in values if v > 0.0]
    if len(nonzero) < 2:
        return []
    threshold = statistics.quantiles(nonzero, n=_PITCH_VARIANCE_PERCENTILE_N)[-1]

    out = []
    for span in idx.scenes:
        if span.t1 - span.t0 < _SCENE_MIN_LEN_S:
            continue
        lo = int(span.t0 / hop_s)
        hi = max(lo + 1, int(span.t1 / hop_s))
        window = values[lo:hi]
        if not window:
            continue
        mean_var = sum(window) / len(window)
        if mean_var < threshold:
            continue
        evidence = [Claim(kind="scene_stable", t=span.t0, value=mean_var)]
        for t0, t1 in _clamp_windows(span.t0, span.t1, duration):
            out.append(Candidate(t0=t0, t1=t1, source="rule_c_scene_pitch", evidence=list(evidence)))
    return out


def _dedupe(candidates: list[Candidate]) -> list[Candidate]:
    """Merge candidates whose windows overlap by IoU>0.5, keeping whichever
    has more evidence (ties keep the one already kept -- deterministic,
    since rules run in a > b > c order and each rule appends in signal
    order).

    ponytail: greedy single pass against `kept`, not a transitive
    clustering -- if A overlaps B and B overlaps C but A doesn't overlap C,
    all three still collapse into one (whichever of A/B is kept first also
    absorbs C). Fine for the sparse candidate counts here; revisit with a
    union-find/interval-merge pass if candidates get dense enough for that
    non-transitivity to actually bite."""
    kept: list[Candidate] = []
    for c in candidates:
        dup_i = next((i for i, k in enumerate(kept) if _iou(c, k) > 0.5), None)
        if dup_i is None:
            kept.append(c)
        elif len(c.evidence) > len(kept[dup_i].evidence):
            kept[dup_i] = c
    return kept


def heuristic_candidates(idx: SignalIndex) -> list[Candidate]:
    """Signal-driven candidate moments -- no LLM. Three independent rules
    (energy+rate proximity, laughter/applause leadup, stable-scene pitch
    variance) each propose windows; overlapping proposals are deduped by
    IoU, and the result is capped at MAX_CANDIDATES, highest-evidence-count
    first."""
    raw = _rule_energy_rate(idx) + _rule_laughter(idx) + _rule_scene_pitch(idx)
    deduped = _dedupe(raw)
    deduped.sort(key=lambda c: (-len(c.evidence), c.t0))
    return deduped[:MAX_CANDIDATES]
