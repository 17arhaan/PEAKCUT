"""Surgeon: deterministic cut refinement. Snaps a Scout/Critic candidate's
raw [t0, t1] window onto natural speech edges -- a preceding silence gap or
a word boundary -- so the rendered clip never opens or closes mid-word
(the exact defect qa.py's WORD_CLIP check flags). No LLM in the default
path; the only optional call is a one-shot tie-break when the t0 snap has
two equally-plausible targets (silence edge vs. word start) within 2s of
each other -- stub mode (SHORTS_LLM=stub, the default, no API key needed)
never calls out and deterministically keeps the earlier of the two.

`repair()` (T14) is the second entry point: given an already-rendered Cut
and the QAFails it triggered, deterministically produce a revised Cut for
WORD_CLIP/ALIGN failures the pipeline's bounded repair loop routes back
here. No LLM here either.
"""

from shorts.agent_log import AgentLog
from shorts.agents.llm import StubModeError, complete_json
from shorts.qa import _ALIGN_P95_MAX_MS
from shorts.signals.index import words_in
from shorts.types import Candidate, Cut, QAFail, SignalIndex

_MIN_SILENCE_DUR_S = 0.3
# ponytail: bounds how far back t0 is allowed to jump -- a silence more than
# this far before the candidate's raw t0 belongs to someone else's content,
# not this clip's lead-in, so it must not be snapped to.
_SILENCE_SEARCH_BACK_S = 5.0
_FILLER_SCAN_WINDOW_S = 2.0
_TRAILING_ROOM_MAX_S = 0.8
_TIE_BREAK_AMBIGUITY_S = 2.0
_MIN_DUR_S = 5.0
_MAX_DUR_S = 90.0

TIE_BREAK_SCHEMA = {
    "required": ["choice"],
    "properties": {"choice": {"type": "number"}},
}


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _lands_mid_word(idx: SignalIndex, t: float) -> bool:
    """True if `t` falls strictly inside a word span -- same strict
    inequality qa._check_word_clip uses (words_in's zero-width-window
    trick), so "never open mid-word" is checked the same way it's
    enforced downstream."""
    return any(w.t0 < t < w.t1 for w in idx.words)


def _silence_edge_before(idx: SignalIndex, t: float) -> float | None:
    """Nearest preceding silence edge (silence.t1) within
    _SILENCE_SEARCH_BACK_S of `t`, long enough (>=0.3s) to be a real speech
    gap and not just a brief pause -- or None if there's no such silence.
    VAD-detected silence and forced-alignment word timestamps come from
    different models and can disagree on real audio (a silence span can
    end a few ms inside a word's measured span); a silence edge that would
    land mid-word per the transcript is disqualified rather than trusted,
    since idx.words is the ground truth qa.WORD_CLIP checks against."""
    candidates = [
        s
        for s in idx.silences
        if s.t1 <= t
        and s.t1 - s.t0 >= _MIN_SILENCE_DUR_S
        and t - s.t1 <= _SILENCE_SEARCH_BACK_S
        and not _lands_mid_word(idx, s.t1)
    ]
    if not candidates:
        return None
    return max(s.t1 for s in candidates)


def _word_start_at_or_before(idx: SignalIndex, t: float) -> float | None:
    """Nearest word START at or before `t` -- None if every word starts
    after t (or there are no words at all)."""
    starts = [w.t0 for w in idx.words if w.t0 <= t]
    return max(starts) if starts else None


def _tie_break_t0(a: float, b: float, log: AgentLog) -> float:
    """One-shot LLM tie-break between two ambiguous t0 snap targets. Stub
    mode (the default) never calls out and deterministically keeps the
    earlier (smaller) target; live mode asks once, no re-ask loop."""
    prompt = (
        "You are the Surgeon agent in a shorts-clipping pipeline, choosing "
        "where to open a clip. Two candidate cut points are both plausible: "
        f"a silence-edge target at t={a:.3f}s and a word-start target at "
        f"t={b:.3f}s. Pick whichever makes for a cleaner, more natural "
        'opening. Respond with ONLY a JSON object of the form {"choice": '
        "<float, exactly one of the two timestamps given>}. No prose, no "
        "markdown fences."
    )
    try:
        data = complete_json(prompt, TIE_BREAK_SCHEMA, "surgeon", log)
    except StubModeError:
        return min(a, b)
    choice = data.get("choice")
    if not _is_number(choice):
        return min(a, b)
    return a if abs(choice - a) <= abs(choice - b) else b


def _snap_t0(cand: Candidate, idx: SignalIndex, log: AgentLog) -> float:
    silence_target = _silence_edge_before(idx, cand.t0)
    word_target = _word_start_at_or_before(idx, cand.t0)

    if (
        silence_target is not None
        and word_target is not None
        and abs(silence_target - word_target) <= _TIE_BREAK_AMBIGUITY_S
    ):
        return _tie_break_t0(silence_target, word_target, log)
    if silence_target is not None:
        return silence_target
    if word_target is not None:
        return word_target
    return cand.t0  # ponytail: nothing to snap to (e.g. empty transcript)


def _first_word_in(idx: SignalIndex, t0: float, t1: float):
    window = words_in(idx, t0, t1)
    return min(window, key=lambda w: w.t0) if window else None


def _in_filler(idx: SignalIndex, word) -> bool:
    return any(s.t0 <= word.t0 and word.t1 <= s.t1 for s in idx.fillers)


def _strip_leading_fillers(t0: float, idx: SignalIndex) -> float:
    """Advance t0 past any leading filler word(s) -- while the first word in
    [t0, t0+2s] sits inside a filler span, jump to the START of the word
    after it. Bounded by len(words) iterations: t0 strictly advances to a
    later word's start each pass, so this always terminates."""
    for _ in range(len(idx.words) + 1):
        first = _first_word_in(idx, t0, t0 + _FILLER_SCAN_WINDOW_S)
        if first is None or not _in_filler(idx, first):
            return t0
        later = [w.t0 for w in idx.words if w.t0 > first.t0]
        if not later:
            return first.t1  # filler is the last word -- nothing to advance to
        t0 = min(later)
    return t0


def _snap_t1(cand: Candidate, idx: SignalIndex) -> float:
    """Nearest word END at or after the candidate's raw t1, plus up to 0.8s
    of trailing room -- capped by the gap to the next word so the result
    never runs into it."""
    ending_at_or_after = [w for w in idx.words if w.t1 >= cand.t1]
    if not ending_at_or_after:
        return cand.t1  # nothing to snap to (t1 past every word) -- keep original
    target = min(ending_at_or_after, key=lambda w: w.t1)

    # >= (not >): a word starting exactly at target.t1 (no gap between them
    # at all) must still be found here, or the "next" word we'd find would
    # be the one after THAT -- overstating the gap and letting the trailing
    # room run straight into the immediately-following word.
    later_starts = [w.t0 for w in idx.words if w.t0 >= target.t1]
    gap = min(later_starts) - target.t1 if later_starts else _TRAILING_ROOM_MAX_S
    return target.t1 + min(_TRAILING_ROOM_MAX_S, max(0.0, gap))


def _payoff_word_i(cand: Candidate, idx: SignalIndex) -> int | None:
    """Index into idx.words of the last word before the candidate's
    strongest evidence claim time -- max |value| among energy_peak claims
    if any exist, else the first claim in evidence order (covers claims
    with string/None values, e.g. quotes, which have no |value| ordering).
    None for a candidate with no evidence at all."""
    if not cand.evidence:
        return None

    energy_claims = [c for c in cand.evidence if c.kind == "energy_peak" and _is_number(c.value)]
    claim = max(energy_claims, key=lambda c: abs(c.value)) if energy_claims else cand.evidence[0]

    last_i = None
    for i, w in enumerate(idx.words):
        if w.t0 <= claim.t:
            last_i = i
    return last_i


def _clamp_duration(t0: float, t1: float, duration: float) -> tuple[float, float]:
    """Clamp a [t0, t1) window to media bounds first, then to the
    [_MIN_DUR_S, _MAX_DUR_S] duration bounds -- position bound takes
    priority (a clip can never extend past the real video, even if that
    means giving up exact word/silence alignment at the very edge of the
    source). Shared by refine() and repair() so every cut-producing path
    enforces the same bounds."""
    t0 = max(0.0, min(t0, duration))
    t1 = max(0.0, min(t1, duration))
    if t1 < t0:
        t0, t1 = t1, t0  # ponytail: degenerate snap collision -- keep Cut well-formed

    if t1 - t0 < _MIN_DUR_S:
        t1 = min(duration, t0 + _MIN_DUR_S)
        t0 = max(0.0, t1 - _MIN_DUR_S)
    elif t1 - t0 > _MAX_DUR_S:
        t1 = t0 + _MAX_DUR_S
    return t0, t1


def refine(cand: Candidate, idx: SignalIndex, log: AgentLog) -> Cut:
    """Deterministically refine `cand`'s raw window into a Cut whose
    boundaries sit on speech edges: t0 snaps to a preceding silence (or,
    failing that, a word start) with leading fillers stripped; t1 snaps to
    a word end plus up to 0.8s of trailing room. Media/duration bounds are
    enforced last and take priority over the snap -- a clip can never
    extend past the real video or outside [5, 90]s, even if that means
    giving up exact word/silence alignment at the very edge of the source."""
    t0 = _snap_t0(cand, idx, log)
    t0 = _strip_leading_fillers(t0, idx)
    t1 = _snap_t1(cand, idx)

    t0, t1 = _clamp_duration(t0, t1, idx.media.duration_s)

    payoff_word_i = _payoff_word_i(cand, idx)

    log.emit(
        "surgeon", "refined",
        {
            "orig_t0": cand.t0, "orig_t1": cand.t1,
            "t0": t0, "t1": t1, "payoff_word_i": payoff_word_i,
        },
    )
    return Cut(t0=t0, t1=t1, payoff_word_i=payoff_word_i)


# --- repair: T14 bounded re-repair for surgeon-routed QA failures ----------


def _repair_word_clip(cut: Cut, idx: SignalIndex, log: AgentLog) -> Cut:
    """Re-run the same t0/t1 boundary-snap rules refine() uses, but anchored
    on the CURRENT cut boundary and only for whichever boundary a word
    actually straddles (words_in's zero-width-window trick, same predicate
    qa._check_word_clip uses) -- the other boundary is left untouched. For a
    straddling word, _snap_t0/_snap_t1's own word-start/word-end rules
    resolve to that same word's own edge, extending the cut to include it
    whole rather than clipping into it."""
    t0, t1 = cut.t0, cut.t1
    if words_in(idx, t0, t0):
        temp = Candidate(t0=t0, t1=t1, source="repair", evidence=[])
        t0 = _strip_leading_fillers(_snap_t0(temp, idx, log), idx)
    if words_in(idx, t1, t1):
        temp = Candidate(t0=t0, t1=t1, source="repair", evidence=[])
        t1 = _snap_t1(temp, idx)
    return Cut(t0=t0, t1=t1, payoff_word_i=cut.payoff_word_i)


def _best_align_run(idx: SignalIndex, t0: float, t1: float) -> tuple[float, float] | None:
    """Longest (by time span) contiguous run of ALIGN-eligible words inside
    [t0, t1) whose own p95 align_err_ms is <=_ALIGN_P95_MAX_MS -- same p95
    formula qa._check_align uses, words with align_err_ms=None skipped, same
    as that check. None if no run qualifies (including "no alignable words
    at all"). # ponytail: O(n^2) scan over the words in one cut -- clip-sized
    word counts (tens, not thousands), upgrade to a sliding window if this
    ever shows up in a profile."""
    words = sorted(
        (w for w in words_in(idx, t0, t1) if w.align_err_ms is not None),
        key=lambda w: w.t0,
    )
    if not words:
        return None

    best: tuple[float, float] | None = None
    best_span = 0.0
    for i in range(len(words)):
        errs: list[float] = []
        for j in range(i, len(words)):
            errs.append(words[j].align_err_ms)
            sorted_errs = sorted(errs)
            p95 = sorted_errs[int(0.95 * (len(sorted_errs) - 1))]
            if p95 <= _ALIGN_P95_MAX_MS:
                span = words[j].t1 - words[i].t0
                if span > best_span:
                    best_span = span
                    best = (words[i].t0, words[j].t1)
    return best


def _repair_align(cut: Cut, idx: SignalIndex) -> Cut:
    """Trim the cut to the longest well-aligned contiguous word run inside
    it, if that run is at least _MIN_DUR_S long -- otherwise this cut can't
    be repaired this way and is returned unchanged (the pipeline's repair
    loop will exhaust its budget and drop the clip)."""
    run = _best_align_run(idx, cut.t0, cut.t1)
    if run is None or run[1] - run[0] < _MIN_DUR_S:
        return cut
    return Cut(t0=run[0], t1=run[1], payoff_word_i=cut.payoff_word_i)


def repair(cut: Cut, idx: SignalIndex, failures: list[QAFail], log: AgentLog) -> Cut:
    """Deterministic, no-LLM repair for surgeon-routed QA failures
    (WORD_CLIP, ALIGN) -- called by the pipeline's bounded repair loop.
    Any other codes mixed into `failures` are ignored here (the pipeline
    only calls this when at least one failure routes to "surgeon"; a
    render-routed code alongside it needs no cut change, just a
    re-render)."""
    codes = {f.code for f in failures}
    new_cut = cut
    if "WORD_CLIP" in codes:
        new_cut = _repair_word_clip(new_cut, idx, log)
    if "ALIGN" in codes:
        new_cut = _repair_align(new_cut, idx)

    t0, t1 = _clamp_duration(new_cut.t0, new_cut.t1, idx.media.duration_s)
    log.emit(
        "surgeon", "repaired",
        {"codes": sorted(codes), "orig_t0": cut.t0, "orig_t1": cut.t1, "t0": t0, "t1": t1},
    )
    return Cut(t0=t0, t1=t1, payoff_word_i=new_cut.payoff_word_i)
