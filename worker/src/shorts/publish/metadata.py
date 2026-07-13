"""Copywriter: YouTube Shorts publish metadata for a rendered clip -- title,
description, hashtags, and tags. LIVE mode (SHORTS_LLM=live) asks the LLM once
and re-asks once on a constraint violation; STUB mode (the default) and any
still-invalid live response fall back to deterministic metadata built from the
hook title + transcript. The model's self-report is never trusted -- every cap
(title/description length, tag budget, hashtag count) is enforced here.
"""

import re

from shorts.agent_log import AgentLog
from shorts.agents.llm import StubModeError, complete_json

_TITLE_MAX = 100  # YouTube title hard cap
_DESC_MAX = 4900  # headroom under YouTube's 5000-char description cap
_TAGS_TOTAL_MAX = 480  # YouTube caps total tag text near 500 chars
_MAX_HASHTAGS = 5
_MAX_TAGS = 12
_SHORTS_TAG = "#Shorts"
# https://developers.google.com/youtube/v3/docs/videoCategories -- 23=Comedy,
# 24=Entertainment. Entertainment is the safe default across clip types.
_DEFAULT_CATEGORY = "24"
_DEFAULT_PRIVACY = "unlisted"

YT_SCHEMA = {
    "required": ["description", "hashtags", "tags"],
    "properties": {
        "description": {"type": "string"},
        "hashtags": {"type": "array"},
        "tags": {"type": "array"},
    },
}


def _clean_hashtag(h: str) -> str | None:
    """A single #word hashtag (alphanumerics only), or None if nothing usable."""
    word = re.sub(r"[^0-9A-Za-z]", "", str(h))
    return f"#{word}" if word else None


def _dedupe(items: list[str]) -> list[str]:
    seen, out = set(), []
    for it in items:
        key = it.lower()
        if key not in seen:
            seen.add(key)
            out.append(it)
    return out


def _title(hook_title: str) -> str:
    """Clip title + a trailing #Shorts (YouTube uses it to classify Shorts),
    hard-capped at the YouTube title limit."""
    base = hook_title.strip()
    if _SHORTS_TAG.lower() in base.lower():
        title = base
    elif len(base) + 1 + len(_SHORTS_TAG) <= _TITLE_MAX:
        title = f"{base} {_SHORTS_TAG}"
    else:
        title = base
    return title[:_TITLE_MAX].rstrip()


def _budget_tags(tags: list[str]) -> list[str]:
    """Keep whole tags until the ~500-char total budget is hit, capped at
    _MAX_TAGS -- mirrors how YouTube truncates an over-budget tag list."""
    out, total = [], 0
    for t in tags:
        t = t.strip()
        if not t:
            continue
        add = len(t) + (1 if out else 0)
        if len(out) >= _MAX_TAGS or total + add > _TAGS_TOTAL_MAX:
            break
        out.append(t)
        total += add
    return out


def _compose(hook_title: str, description: str, hashtags: list[str], tags: list[str]) -> dict:
    """Assemble the enforced publish.json from raw parts (from the LLM or the
    fallback) -- shared by both paths so caps are applied in exactly one place.
    #Shorts is guaranteed present in the hashtag line; the description ends with
    the hashtag block (that's what YouTube surfaces on the Short)."""
    clean_tags_hashes = [ht for ht in (_clean_hashtag(h) for h in hashtags) if ht]
    hashtags_final = _dedupe([_SHORTS_TAG, *clean_tags_hashes])[:_MAX_HASHTAGS]

    body = description.strip()
    hashline = " ".join(hashtags_final)
    # keep the hashtag line out of the body if the model already appended it
    body_no_tags = re.sub(r"(?:\s*#\w+)+\s*$", "", body).strip()
    full = f"{body_no_tags}\n\n{hashline}".strip()
    if len(full) > _DESC_MAX:
        full = full[:_DESC_MAX].rstrip()

    return {
        "platform": "youtube",
        "title": _title(hook_title),
        "description": full,
        "hashtags": hashtags_final,
        "tags": _budget_tags(_dedupe([*tags, "shorts"])),
        "categoryId": _DEFAULT_CATEGORY,
        "privacyStatus": _DEFAULT_PRIVACY,
    }


def _fallback(hook_title: str, transcript: str) -> dict:
    """No-LLM metadata: description = hook line + a trimmed transcript excerpt;
    hashtags/tags derived from the title words. Always valid."""
    words = [w for w in re.findall(r"[A-Za-z']+", hook_title) if len(w) > 2]
    excerpt = transcript.strip()
    if len(excerpt) > 300:
        excerpt = excerpt[:300].rsplit(" ", 1)[0].rstrip() + "…"
    description = f"{hook_title.strip()}\n\n{excerpt}" if excerpt else hook_title.strip()
    hashtags = [f"#{w.lower()}" for w in words[:3]]
    tags = [w.lower() for w in words]
    return _compose(hook_title, description, hashtags, tags)


def _prompt(hook_title: str, transcript: str) -> str:
    return (
        "You are the Copywriter for a short-form video pipeline, writing the "
        "YouTube Shorts post for one clip. Given the clip's on-screen hook and "
        "its transcript, write:\n"
        "- description: 1-3 short lines that hook the viewer and say what the "
        "moment is (no clickbait, no fake promises, no emojis-only lines);\n"
        f"- hashtags: {_MAX_HASHTAGS - 1}-4 relevant hashtags (no # needed, "
        "plain words), topical to the clip;\n"
        f"- tags: up to {_MAX_TAGS} search keywords/phrases.\n\n"
        f"Hook: {hook_title}\nTranscript: {transcript}\n\n"
        'Respond with ONLY a JSON object: {"description": <str>, "hashtags": '
        '[<str>...], "tags": [<str>...]}. No prose, no markdown fences.'
    )


def _parse(data: dict) -> tuple[str, list, list] | None:
    desc, hashtags, tags = data.get("description"), data.get("hashtags"), data.get("tags")
    if not isinstance(desc, str) or not isinstance(hashtags, list) or not isinstance(tags, list):
        return None
    return desc, [str(h) for h in hashtags], [str(t) for t in tags]


def build_youtube_metadata(hook_title: str, transcript: str, log: AgentLog) -> dict:
    """Publish.json dict for one clip. LIVE asks the LLM once, re-asking once on
    a malformed response, then falls back deterministically. STUB uses the
    fallback directly. The returned dict is always cap-valid."""
    try:
        data = complete_json(_prompt(hook_title, transcript), YT_SCHEMA, "copywriter", log)
    except StubModeError:
        return _fallback(hook_title, transcript)

    parsed = _parse(data)
    if parsed is None:
        reask = _prompt(hook_title, transcript) + (
            "\n\nYour previous response was malformed. Respond again with ONLY a "
            "JSON object with string 'description' and array 'hashtags'/'tags'."
        )
        try:
            parsed = _parse(complete_json(reask, YT_SCHEMA, "copywriter", log))
        except StubModeError:
            parsed = None
    if parsed is None:
        log.emit("copywriter", "fallback_used", {"hook": hook_title})
        return _fallback(hook_title, transcript)

    description, hashtags, tags = parsed
    meta = _compose(hook_title, description, hashtags, tags)
    log.emit("copywriter", "written", {"hook": hook_title, "title": meta["title"], "mode": "live"})
    return meta


if __name__ == "__main__":
    # ponytail: quick manual self-check of the pure assembly/caps -- not a
    # substitute for tests/test_publish_metadata.py.
    m = _fallback("Jim Trains Dwight Like Pavlov's Dog", "Every time I reboot he expects a mint.")
    assert m["title"].endswith(_SHORTS_TAG) and len(m["title"]) <= _TITLE_MAX
    assert _SHORTS_TAG in m["hashtags"] and len(m["hashtags"]) <= _MAX_HASHTAGS
    assert m["description"].strip().endswith(m["hashtags"][-1])  # ends on the hashtag line
    assert len(m["tags"]) <= _MAX_TAGS
    long = _compose("t", "x", ["a"] * 20, [f"tag{i}longword" for i in range(40)])
    assert len(long["hashtags"]) <= _MAX_HASHTAGS and len(long["tags"]) <= _MAX_TAGS
    print("metadata self-check OK")
