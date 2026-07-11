"""Tests for shorts.agents.hooks: hook title + platform captions, with every
constraint enforced in code (never trusted from the LLM). Hand-built tiny
SignalIndex objects and monkeypatched complete_json -- no real media,
consistent with test_critic.py/test_scout_llm.py."""

import json

from shorts.agent_log import AgentLog
from shorts.agents import hooks
from shorts.agents.hooks import _fallback, _violations
from shorts.agents.hooks import write as hooks_write
from shorts.qa import _check_safe_area
from shorts.types import Cut, Curve, MediaInfo, SignalIndex, Word


def _mk_index(**overrides) -> SignalIndex:
    defaults = dict(
        version=1,
        media=MediaInfo(duration_s=100.0, fps=30.0, width=1920, height=1080),
        language="en",
        words=[],
        fillers=[],
        speech=[],
        silences=[],
        energy=Curve(hop_s=0.05, values=[]),
        peaks=[],
        rate=Curve(hop_s=1.0, values=[]),
        pitch=Curve(hop_s=1.0, values=[]),
        surges=[],
        monotone=[],
        events=[],
        scenes=[],
        faces=[],
        motion=Curve(hop_s=0.5, values=[]),
        defects_black=[],
        defects_frozen=[],
    )
    defaults.update(overrides)
    return SignalIndex(**defaults)


def _words(text: str, start: float = 0.0, step: float = 0.3) -> list[Word]:
    out = []
    t = start
    for w in text.split():
        out.append(Word(text=w, t0=t, t1=t + step * 0.8, conf=0.9))
        t += step
    return out


def _log(tmp_path, name: str = "agent_events.jsonl") -> AgentLog:
    return AgentLog(tmp_path / name)


def _records(log: AgentLog) -> list[dict]:
    return [json.loads(line) for line in log.path.read_text().splitlines()]


# --- stub mode: deterministic fallback -------------------------------------


def test_stub_mode_uses_fallback_directly(tmp_path):
    idx = _mk_index(words=_words("this is a great long transcript about many things happening"))
    cut = Cut(t0=0.0, t1=30.0)

    hook = hooks_write(cut, idx, _log(tmp_path))

    assert hook.title == "This Is A Great Long Transcript"
    assert hook.captions["tiktok"].startswith("this is a great long transcript")


def test_stub_fallback_is_deterministic(tmp_path):
    idx = _mk_index(words=_words("the quick brown fox jumps over the lazy dog today"))
    cut = Cut(t0=0.0, t1=30.0)

    a = hooks_write(cut, idx, _log(tmp_path, "a.jsonl"))
    b = hooks_write(cut, idx, _log(tmp_path, "b.jsonl"))

    assert a == b


def test_fallback_no_words_uses_default_title(tmp_path):
    idx = _mk_index(words=[])
    cut = Cut(t0=0.0, t1=5.0)

    hook = _fallback(cut, idx)

    assert hook.title == "Watch This Clip"
    assert all(c == "" for c in hook.captions.values())


def test_fallback_caption_caps_are_respected(tmp_path):
    long_text = " ".join(f"word{i}" for i in range(60))
    idx = _mk_index(words=_words(long_text))
    cut = Cut(t0=0.0, t1=30.0)

    hook = _fallback(cut, idx)

    assert len(hook.captions["tiktok"]) <= 150
    assert len(hook.captions["reels"]) <= 125
    assert len(hook.captions["shorts"]) <= 100
    assert hook.captions["shorts"].endswith("…")


def test_fallback_title_never_exceeds_safe_area_property():
    """Property: no matter the transcript, the fallback title must always
    pass qa's SAFE_AREA check -- even pathologically long words."""
    transcripts = [
        "supercalifragilisticexpialidocious another extremely long word here too",
        "a b c d e f g h i j",
        "hi",
        "",
        "x" * 39 + " " + "y" * 39 + " " + "z" * 39,
    ]
    for t in transcripts:
        idx = _mk_index(words=_words(t) if t else [])
        cut = Cut(t0=0.0, t1=30.0)
        hook = _fallback(cut, idx)
        assert _check_safe_area(hook, 1080) is None, hook.title


# --- live mode: constraint enforcement --------------------------------------


def _good_response() -> dict:
    return {
        "title": "A Short Punchy Hook",
        "captions": {
            "tiktok": "tiktok caption",
            "reels": "reels caption",
            "shorts": "shorts caption",
        },
    }


def test_live_accepts_a_clean_response_no_reask(tmp_path, monkeypatch):
    idx = _mk_index(words=_words("hello world this is a test"))
    cut = Cut(t0=0.0, t1=5.0)
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        return _good_response()

    monkeypatch.setattr(hooks, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    hook = hooks_write(cut, idx, log)

    assert len(calls) == 1
    assert hook.title == "A Short Punchy Hook"
    assert hook.captions == {
        "tiktok": "tiktok caption",
        "reels": "reels caption",
        "shorts": "shorts caption",
    }


def test_live_title_too_long_reasks_then_falls_back(tmp_path, monkeypatch):
    idx = _mk_index(words=_words("hello world this is a test transcript for fallback purposes"))
    cut = Cut(t0=0.0, t1=30.0)
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        bad = _good_response()
        bad["title"] = "This Title Has Way More Than Eight Words In It"
        return bad

    monkeypatch.setattr(hooks, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    hook = hooks_write(cut, idx, log)

    assert len(calls) == 2
    assert "words, max 8" in calls[1]
    assert hook.title == "Hello World This Is A Test"  # deterministic fallback

    records = _records(log)
    assert any(r["action"] == "fallback_used" for r in records)


def test_live_banned_phrase_reasks_then_falls_back(tmp_path, monkeypatch):
    idx = _mk_index(words=_words("hello world this is a test transcript"))
    cut = Cut(t0=0.0, t1=30.0)
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        bad = _good_response()
        bad["title"] = "You Won't Believe This"
        return bad

    monkeypatch.setattr(hooks, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    hook = hooks_write(cut, idx, log)

    assert len(calls) == 2
    assert "banned phrase" in calls[1]
    assert hook.title != "You Won't Believe This"


def test_live_profanity_reasks_then_falls_back(tmp_path, monkeypatch):
    idx = _mk_index(words=_words("hello world this is a test transcript"))
    cut = Cut(t0=0.0, t1=30.0)
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        bad = _good_response()
        bad["title"] = "This Hook Is Complete Shit"
        return bad

    monkeypatch.setattr(hooks, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    hook = hooks_write(cut, idx, log)

    assert len(calls) == 2
    assert "profanity" in calls[1]
    assert hook.title != "This Hook Is Complete Shit"


def test_live_caption_over_cap_reasks_then_falls_back(tmp_path, monkeypatch):
    idx = _mk_index(words=_words("hello world this is a test transcript"))
    cut = Cut(t0=0.0, t1=30.0)
    calls = []

    def fake_complete_json(prompt, schema, agent, log):
        calls.append(prompt)
        bad = _good_response()
        bad["captions"]["tiktok"] = "x" * 200
        return bad

    monkeypatch.setattr(hooks, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    hook = hooks_write(cut, idx, log)

    assert len(calls) == 2
    assert "tiktok caption is 200 chars" in calls[1]
    assert len(hook.captions["tiktok"]) <= 150


def test_live_still_bad_after_reask_logs_fallback_with_violations(tmp_path, monkeypatch):
    idx = _mk_index(words=_words("hello world this is a test transcript here"))
    cut = Cut(t0=0.0, t1=30.0)

    def fake_complete_json(prompt, schema, agent, log):
        bad = _good_response()
        bad["title"] = "You Won't Believe This One Weird Trick Today"
        return bad

    monkeypatch.setattr(hooks, "complete_json", fake_complete_json)
    log = _log(tmp_path)

    hook = hooks_write(cut, idx, log)

    assert hook.title == "Hello World This Is A Test"
    records = _records(log)
    fallback_records = [r for r in records if r["action"] == "fallback_used"]
    assert len(fallback_records) == 1
    assert fallback_records[0]["payload"]["violations"]


def test_violations_pure_function():
    assert _violations("A short title", {"tiktok": "x", "reels": "y", "shorts": "z"}) == []
    assert _violations(
        "one two three four five six seven eight nine",
        {"tiktok": "x", "reels": "y", "shorts": "z"},
    )


def test_profanity_with_punctuation():
    """Profanity should be detected even when wrapped in punctuation."""
    violations = _violations("This Is Complete Shit.", {"tiktok": "x", "reels": "y", "shorts": "z"})
    assert any("profanity" in v for v in violations), f"Expected profanity violation, got {violations}"

    violations = _violations("What the fuck!", {"tiktok": "x", "reels": "y", "shorts": "z"})
    assert any("profanity" in v for v in violations), f"Expected profanity violation, got {violations}"

    violations = _violations("This is damn annoying.", {"tiktok": "x", "reels": "y", "shorts": "z"})
    assert any("profanity" in v for v in violations), f"Expected profanity violation, got {violations}"


def test_banned_phrase_without_apostrophe():
    """Banned phrases should be detected even when apostrophes are omitted."""
    violations = _violations("You wont believe this", {"tiktok": "x", "reels": "y", "shorts": "z"})
    assert any("banned phrase" in v for v in violations), f"Expected banned phrase violation, got {violations}"

    violations = _violations("Gone wrong in the shop", {"tiktok": "x", "reels": "y", "shorts": "z"})
    assert any("banned phrase" in v for v in violations), f"Expected banned phrase violation, got {violations}"


def test_clean_title_passes():
    """A clean title should pass all checks."""
    violations = _violations("Amazing Tech Tips Today", {"tiktok": "x", "reels": "y", "shorts": "z"})
    assert violations == [], f"Expected clean title, got violations: {violations}"
