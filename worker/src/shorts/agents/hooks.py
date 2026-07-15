"""Hook Writer: on-screen hook title + per-platform captions for a Cut.

Every constraint is enforced in code -- the LLM's claims about its own
output are never trusted. LIVE mode (SHORTS_LLM=live) asks the LLM once; a
response that violates a constraint (title too long, a banned/clickbait
phrase, profanity, or an over-cap caption) gets ONE re-ask carrying the
specific violations, same shape as critic.py/scout.py's evidence re-ask.
A response still violating after that -- or STUB mode (SHORTS_LLM=stub, the
default, no API key needed), which never calls out at all -- falls back to
a fully deterministic title/captions built straight from the cut's own
transcript.
"""

import string

from shorts.agent_log import AgentLog
from shorts.agents.llm import LlmError, StubModeError, complete_json
from shorts.qa import SAFE_AREA_MAX_CHARS as _SAFE_AREA_MAX_CHARS
from shorts.signals.index import words_in
from shorts.types import Cut, Hook, SignalIndex

_MAX_TITLE_WORDS = 8
_FALLBACK_TITLE_WORDS = 6
_CAPTION_CAPS = {"tiktok": 150, "reels": 125, "shorts": 100}
_PLATFORMS = tuple(_CAPTION_CAPS)

# Imported from qa.py, the single source of truth -- both the live-LLM path
# (_violations, enforced below) and the fallback (_fallback) are budgeted to
# this SAME char cap, so a hook can never be generated here and then dropped
# by qa._check_safe_area for being too long.

# ponytail: clickbait ban list -- extend freely, matched case-insensitive
# substring against the title.
_BANNED_PHRASES = frozenset({
    "you won't believe",
    "gone wrong",
    "wait for it",
    "watch till the end",
    "number 7 will",
    "doctors hate",
})

# ponytail: small, obviously-safe starter set (mild words only) -- extend if
# the domain needs it. Matched as whole title tokens, not substrings, so it
# doesn't false-positive on words like "class" or "assess".
_PROFANITY = frozenset({"fuck", "shit", "bitch", "asshole", "damn", "crap"})

HOOK_LLM_SCHEMA = {
    "required": ["title", "captions"],
    "properties": {"title": {"type": "string"}, "captions": {"type": "object"}},
}


def _normalize_for_match(s: str) -> str:
    """Normalize text for banned phrase matching: lowercase, remove apostrophes,
    collapse whitespace. Keeps other punctuation at token boundaries."""
    normalized = s.lower().replace("'", "").replace('"', "")
    return " ".join(normalized.split())


def _violations(title: str, captions: dict) -> list[str]:
    """Every constraint violation of `title`/`captions`, checked in code."""
    out = []
    words = title.split()
    if len(words) > _MAX_TITLE_WORDS:
        out.append(f"title has {len(words)} words, max {_MAX_TITLE_WORDS}")
    if len(title) > _SAFE_AREA_MAX_CHARS:
        out.append(f"title is {len(title)} chars, max {_SAFE_AREA_MAX_CHARS}")

    lowered = title.lower()
    normalized_title = _normalize_for_match(title)
    for phrase in sorted(_BANNED_PHRASES):
        normalized_phrase = _normalize_for_match(phrase)
        if normalized_phrase in normalized_title:
            out.append(f"title contains banned phrase {phrase!r}")

    # Strip punctuation from each token before checking profanity.
    tokens = [w.strip(string.punctuation) for w in lowered.split()]
    hit_profanity = _PROFANITY & set(tokens)
    if hit_profanity:
        out.append(f"title contains profanity: {sorted(hit_profanity)}")

    for platform in _PLATFORMS:
        cap = _CAPTION_CAPS[platform]
        caption = captions.get(platform)
        if not isinstance(caption, str):
            out.append(f"{platform} caption missing or not a string")
            continue
        if len(caption) > cap:
            out.append(f"{platform} caption is {len(caption)} chars, max {cap}")

    return out


def _title_case(words: list[str]) -> str:
    text = " ".join(words).strip().rstrip(".,!?;:-")
    return text.title() if text else ""


def _truncate(text: str, cap: int) -> str:
    """Word-boundary truncate to at most `cap` chars (ellipsis included);
    text already within the cap is returned unchanged."""
    if len(text) <= cap:
        return text
    truncated = text[: cap - 1].rstrip()
    if " " in truncated:
        truncated = truncated.rsplit(" ", 1)[0]
    return truncated.rstrip() + "…"


def _fallback(cut: Cut, idx: SignalIndex) -> Hook:
    """Deterministic, no-LLM hook: title = first 6 words of the cut's
    transcript (title-cased, no trailing punctuation), hard-capped at
    qa's SAFE_AREA char limit -- this GUARANTEES the fallback always passes
    SAFE_AREA, even for pathologically long words. Captions = the full
    transcript truncated to each platform's cap."""
    words = [w.text for w in words_in(idx, cut.t0, cut.t1)]
    transcript = " ".join(words)

    title = _title_case(words[:_FALLBACK_TITLE_WORDS]) or "Watch This Clip"
    if len(title) > _SAFE_AREA_MAX_CHARS:
        title = title[:_SAFE_AREA_MAX_CHARS].rstrip()

    captions = {p: _truncate(transcript, cap) for p, cap in _CAPTION_CAPS.items()}
    return Hook(title=title, captions=captions)


def _prompt(transcript: str) -> str:
    return (
        "You are the Hook Writer agent in a shorts-clipping pipeline. Given "
        "the transcript of a short-form video clip, write an on-screen hook "
        f"title (at most {_MAX_TITLE_WORDS} words AND at most "
        f"{_SAFE_AREA_MAX_CHARS} characters, no clickbait phrases like "
        '"you won\'t believe" or "wait for it", no profanity) and a caption '
        "for each platform (tiktok, reels, shorts) summarizing the clip, "
        f"within {_CAPTION_CAPS['tiktok']}/{_CAPTION_CAPS['reels']}/"
        f"{_CAPTION_CAPS['shorts']} characters respectively.\n\n"
        f"Transcript: {transcript}\n\n"
        'Respond with ONLY a JSON object of the form {"title": <str>, '
        '"captions": {"tiktok": <str>, "reels": <str>, "shorts": <str>}}. '
        "No prose, no markdown fences."
    )


def _parse(data: dict) -> tuple[str, dict] | None:
    title, captions = data.get("title"), data.get("captions")
    if not isinstance(title, str) or not isinstance(captions, dict):
        return None
    return title, captions


def _live_write(cut: Cut, idx: SignalIndex, log: AgentLog) -> Hook:
    transcript = " ".join(w.text for w in words_in(idx, cut.t0, cut.t1))
    prompt = _prompt(transcript)
    data = complete_json(prompt, HOOK_LLM_SCHEMA, "hooks", log)
    parsed = _parse(data)
    violations = _violations(*parsed) if parsed else ["malformed response (missing title/captions)"]

    if violations:
        reask_prompt = (
            f"{prompt}\n\nYour previous response violated these constraints:\n"
            + "\n".join(f"- {v}" for v in violations)
            + "\n\nRespond again with ONLY a corrected JSON object in the same schema."
        )
        data = complete_json(reask_prompt, HOOK_LLM_SCHEMA, "hooks", log)
        parsed = _parse(data)
        violations = _violations(*parsed) if parsed else ["malformed response (missing title/captions)"]
        if violations:
            log.emit(
                "hooks", "fallback_used",
                {"t0": cut.t0, "t1": cut.t1, "violations": violations},
            )
            return _fallback(cut, idx)

    title, captions = parsed
    log.emit("hooks", "written", {"t0": cut.t0, "t1": cut.t1, "title": title, "mode": "live"})
    return Hook(title=title, captions={p: captions[p] for p in _PLATFORMS})


def write(cut: Cut, idx: SignalIndex, log: AgentLog) -> Hook:
    """Write a Hook for `cut`. LIVE mode (SHORTS_LLM=live) asks the LLM
    once, re-asking exactly once on constraint violation and falling back
    to a deterministic transcript-derived Hook if the second try still
    violates. STUB mode (the default, no API key needed) always uses the
    fallback path directly."""
    try:
        return _live_write(cut, idx, log)
    except StubModeError:
        return _fallback(cut, idx)
    except LlmError as e:
        # one malformed model reply must not kill the run -- the
        # transcript-derived fallback hook ships instead
        log.emit("hooks", "degraded_to_fallback", {"reason": str(e)[:300]})
        return _fallback(cut, idx)


if __name__ == "__main__":
    # ponytail: quick manual self-check of the pure helpers, not a
    # substitute for tests/test_hooks.py -- run `python -m shorts.agents.hooks`.
    assert _violations("A short title", {"tiktok": "x", "reels": "y", "shorts": "z"}) == []
    assert _violations("one two three four five six seven eight nine", {}) != []
    assert _truncate("hello world", 100) == "hello world"
    assert _truncate("hello world", 8) == "hello…"
    print("hooks self-check OK")
