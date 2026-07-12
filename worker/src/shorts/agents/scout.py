"""Scout: candidate-moment finder over a SignalIndex. Two passes feed the
same evidence-gate vocabulary (a later Critic task consumes it):

  - heuristic_candidates(idx): three overlap rules over the raw signals,
    no LLM, always run.
  - candidates(idx, log): the full entrypoint -- heuristic pass plus (live
    mode only) an LLM semantic pass over the transcript, looking for hot
    takes/stories/punchlines/questions. LLM candidates must cite Claims
    that pass agents.evidence.validate_claims before admission; a
    candidate whose evidence doesn't resolve gets one re-ask with the
    violation reasons appended, then is discarded if it still doesn't
    resolve. Stub mode (SHORTS_LLM=stub, the default) skips the LLM pass
    entirely and returns heuristic-only results.
"""

import math
import statistics

from shorts.agent_log import AgentLog
from shorts.agents.evidence import validate_claims
from shorts.agents.llm import StubModeError, complete_json
from shorts.signals.index import events_in, peaks_in
from shorts.types import Candidate, Claim, SignalIndex, Span

MAX_CANDIDATES = 20
MIN_LEN_S = 30.0
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
    """Clamp a raw (t0, t1) window to [0, duration] and to a 30-90s length.
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


# --- LLM semantic pass ---------------------------------------------------

# ponytail: cost ceiling -- one complete_json call per ~2000-word chunk.
# Every fixture here is small enough to be one chunk; a multi-hour video
# would mean dozens of calls with no cap on total spend yet -- the
# Critic's per-run token budget (later task) is where that gets enforced,
# not here.
_CHUNK_WORDS = 2000
_TIMESTAMP_EVERY_N_WORDS = 10

_CLAIM_VOCABULARY = """\
energy_peak  -- a measured RMS energy spike near that timestamp (value = sigma above baseline)
laughter     -- a detected laughter audio event at that timestamp
applause     -- a detected applause audio event at that timestamp
rate_surge   -- a speaking-rate surge span containing that timestamp
silence      -- a silence span near that timestamp
scene_stable -- a stable camera scene (>=15s) containing that timestamp
quote        -- value is a verbatim substring of the transcript starting at that timestamp"""

SCOUT_LLM_SCHEMA = {
    "required": ["candidates"],
    "properties": {"candidates": {"type": "array"}},
}


def _transcript_chunks(idx: SignalIndex) -> list[str]:
    """Format idx.words as ~2000-word chunks, each with a second-resolution
    timestamp every ~10 words -- every fixture in this repo is small enough
    to be a single chunk."""
    words = idx.words
    chunks = []
    for i in range(0, len(words), _CHUNK_WORDS):
        piece = words[i : i + _CHUNK_WORDS]
        tokens = []
        for j, w in enumerate(piece):
            if j % _TIMESTAMP_EVERY_N_WORDS == 0:
                tokens.append(f"[{w.t0:.0f}s]")
            tokens.append(w.text)
        chunks.append(" ".join(tokens))
    return chunks


def _prompt(transcript_chunk: str, note: str = "") -> str:
    return (
        "You are the Scout agent in a shorts-clipping pipeline. Given a "
        "transcript excerpt (bracketed second-resolution timestamps every "
        "~10 words), find candidate moments worth clipping as a short: hot "
        "takes, short self-contained stories, punchlines, or interesting "
        "questions.\n\n"
        "Every candidate must cite at least one evidence claim from this "
        "vocabulary ONLY, and every claim must be something you can "
        "actually observe in the transcript below -- do not invent "
        "timestamps or values:\n"
        f"{_CLAIM_VOCABULARY}\n\n"
        "Transcript:\n"
        f"{transcript_chunk}\n\n"
        + (f"{note}\n\n" if note else "")
        + 'Respond with ONLY a JSON object of the form {"candidates": '
        '[{"t0": <float>, "t1": <float>, "reason": <str>, "evidence": '
        '[{"kind": <str>, "t": <float>, "value": <float|str|null>}]}]}. '
        "No prose, no markdown fences."
    )


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_evidence(raw: object) -> list[Claim] | None:
    """Build Claims from a raw evidence list; None if the list itself, or
    any single entry in it, is malformed -- the whole candidate is
    discarded in that case (not just the bad entry), per the LLM response
    schema."""
    if not isinstance(raw, list):
        return None
    claims = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None
        kind, t, value = entry.get("kind"), entry.get("t"), entry.get("value")
        if not isinstance(kind, str) or not _is_number(t):
            return None
        if value is not None and not isinstance(value, (str, int, float)):
            return None
        if isinstance(value, bool):
            return None
        claims.append(Claim(kind=kind, t=float(t), value=value))
    return claims


def _parse_llm_candidates(
    data: dict, idx: SignalIndex, log: AgentLog
) -> tuple[list[Candidate], list[tuple[Candidate, list]]]:
    """Parse one complete_json response into (admitted, failing) LLM
    candidates -- `failing` pairs each candidate with the Violations its
    evidence produced, for the caller to build a re-ask prompt from.
    Malformed candidates (bad t0/t1 or evidence) are discarded and logged
    here, not passed to either bucket."""
    duration = idx.media.duration_s
    admitted: list[Candidate] = []
    failing: list[tuple[Candidate, list]] = []
    for raw in data.get("candidates", []):
        if not isinstance(raw, dict):
            continue
        t0, t1 = raw.get("t0"), raw.get("t1")
        if not _is_number(t0) or not _is_number(t1):
            log.emit("scout", "llm_candidate_discarded", {"reason": "malformed t0/t1", "raw": raw})
            continue
        claims = _parse_evidence(raw.get("evidence"))
        if claims is None:
            log.emit(
                "scout", "llm_candidate_discarded",
                {"reason": "malformed evidence entry", "raw": raw},
            )
            continue
        reason = raw.get("reason", "")
        for wt0, wt1 in _clamp_windows(float(t0), float(t1), duration):
            candidate = Candidate(
                t0=wt0, t1=wt1, source="llm", evidence=list(claims),
                notes=reason if isinstance(reason, str) else "",
            )
            violations = validate_claims(claims, idx, Span(t0=wt0, t1=wt1))
            if violations:
                failing.append((candidate, violations))
            else:
                admitted.append(candidate)
    return admitted, failing


def _llm_candidates(idx: SignalIndex, log: AgentLog, note: str = "") -> list[Candidate]:
    """LLM semantic pass: one complete_json call per transcript chunk,
    evidence-gated before admission. A candidate whose evidence fails
    validate_claims gets one re-ask (this chunk's prompt plus the
    violation reasons appended) -- still-failing candidates after that are
    discarded and logged, never admitted. `note` (used by the orchestrator's
    borderline-refinement round) is appended to every chunk's prompt
    verbatim."""
    out: list[Candidate] = []
    for chunk in _transcript_chunks(idx):
        prompt = _prompt(chunk, note)
        data = complete_json(prompt, SCOUT_LLM_SCHEMA, "scout", log)
        admitted, failing = _parse_llm_candidates(data, idx, log)
        out.extend(admitted)
        if not failing:
            continue

        reasons = "\n".join(
            f"- candidate [{c.t0:.1f}, {c.t1:.1f}]: " + "; ".join(v.reason for v in vs)
            for c, vs in failing
        )
        reask_prompt = (
            f"{prompt}\n\nThe following candidates were rejected because their "
            f"evidence could not be verified against the video's measured signals:\n"
            f"{reasons}\n\nRespond again with ONLY corrected, verifiable candidates "
            "in the same JSON schema."
        )
        data = complete_json(reask_prompt, SCOUT_LLM_SCHEMA, "scout", log)
        admitted, failing = _parse_llm_candidates(data, idx, log)
        out.extend(admitted)
        for candidate, violations in failing:
            log.emit(
                "scout", "llm_candidate_discarded",
                {
                    "reason": "evidence violation after re-ask",
                    "t0": candidate.t0,
                    "t1": candidate.t1,
                    "violations": [v.reason for v in violations],
                },
            )
    return out


def candidates(idx: SignalIndex, log: AgentLog, note: str = "") -> list[Candidate]:
    """Full Scout pass: heuristic rules always, plus (live mode only) the
    LLM semantic pass. Stub mode (SHORTS_LLM=stub, the default -- no API
    key needed) makes _llm_candidates raise StubModeError on its first
    call; that's caught here and logged, so `--llm stub` stays a
    deterministic, heuristic-only, fully offline run. `note` is passed
    through to the LLM pass verbatim -- the orchestrator uses it to ask
    Scout to refine borderline windows on its second round."""
    heuristic = heuristic_candidates(idx)
    try:
        llm = _llm_candidates(idx, log, note)
    except StubModeError:
        log.emit("scout", "llm_pass_skipped", {"reason": "stub mode -- heuristic only"})
        return heuristic

    combined = _dedupe(heuristic + llm)
    combined.sort(key=lambda c: (-len(c.evidence), c.t0))
    return combined[:MAX_CANDIDATES]


def fallback_candidates(idx: SignalIndex, n: int) -> list[Candidate]:
    """ponytail: best-effort padding for quiet content where the heuristic
    (and LLM) passes genuinely find nothing -- evenly-spaced SPEECH-WINDOW
    candidates, no evidence attached, used by orchestrator._best_effort when
    the Scout->Critic rounds end with zero keepers.

    N target midpoints are spread evenly across the total speech coverage
    (idx.speech spans concatenated into one virtual timeline), then mapped
    back to real time -- so windows land inside/anchored to speech instead
    of possibly landing in a silent stretch."""
    duration = idx.media.duration_s
    if duration <= 0 or n <= 0:
        return []

    speech = sorted(idx.speech, key=lambda s: s.t0)
    total_speech = sum(max(0.0, s.t1 - s.t0) for s in speech)
    span = min(30.0, max(MIN_LEN_S, duration / n))

    if total_speech <= 0.0:
        # ponytail: no speech at all (e.g. a hand-built index, or a truly
        # silent clip) -- nothing to anchor to, so fall back to the old
        # duration-based even spacing.
        midpoints = [(i + 0.5) * duration / n for i in range(n)]
    else:
        midpoints = [_speech_time_at(speech, (i + 0.5) * total_speech / n) for i in range(n)]

    out: list[Candidate] = []
    for mid in midpoints:
        t0, t1 = _window_around(mid, span, duration)
        if t1 - t0 < 1e-9:
            continue
        # very short video: evenly-spaced midpoints can land closer together
        # than the window width, producing overlapping near-duplicate
        # windows once each is clamped/shifted to fit -- drop those extras
        # rather than emit them.
        if any(_iou(Candidate(t0=t0, t1=t1, source="fallback", evidence=[]), c) > 0.5 for c in out):
            continue
        out.append(Candidate(t0=t0, t1=t1, source="fallback", evidence=[]))
    return out


def _speech_time_at(speech: list[Span], virtual_t: float) -> float:
    """Map a position on the "concatenated speech spans" virtual timeline
    back to a real timestamp."""
    cum = 0.0
    for s in speech:
        length = s.t1 - s.t0
        if virtual_t <= cum + length:
            return s.t0 + (virtual_t - cum)
        cum += length
    return speech[-1].t1 if speech else virtual_t


def _window_around(mid: float, span: float, duration: float) -> tuple[float, float]:
    """A `span`-second window centered on `mid`, shifted (not just clipped)
    to stay inside [0, duration]."""
    t0 = mid - span / 2
    t1 = mid + span / 2
    if t0 < 0.0:
        t1 += -t0
        t0 = 0.0
    if t1 > duration:
        t0 -= t1 - duration
        t1 = duration
    return max(0.0, t0), t1
