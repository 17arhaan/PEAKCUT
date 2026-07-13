"""Tests for the Copywriter (publish.metadata): cap enforcement, the
deterministic fallback, and the live/stub paths (SDK mocked, no network)."""

from types import SimpleNamespace
from unittest.mock import patch

from shorts.agent_log import AgentLog
from shorts.publish.metadata import (
    _MAX_HASHTAGS,
    _MAX_TAGS,
    _TITLE_MAX,
    _SHORTS_TAG,
    _compose,
    _fallback,
    build_youtube_metadata,
)


def test_fallback_is_always_cap_valid(tmp_path):
    m = _fallback("Jim Trains Dwight Like Pavlov's Dog", "Every reboot he expects a mint. " * 40)
    assert m["title"].endswith(_SHORTS_TAG) and len(m["title"]) <= _TITLE_MAX
    assert _SHORTS_TAG in m["hashtags"] and len(m["hashtags"]) <= _MAX_HASHTAGS
    assert len(m["tags"]) <= _MAX_TAGS
    assert m["privacyStatus"] == "unlisted"  # never publishes public by default


def test_compose_enforces_all_caps():
    m = _compose("t", "body", ["a"] * 30, [f"keyword{i}phrase" for i in range(50)])
    assert len(m["hashtags"]) <= _MAX_HASHTAGS
    assert len(m["tags"]) <= _MAX_TAGS
    assert sum(len(t) for t in m["tags"]) <= 480 + len(m["tags"])  # under the tag budget
    assert m["hashtags"][0] == _SHORTS_TAG  # #Shorts always first


def test_compose_does_not_duplicate_a_trailing_hashtag_line():
    # model already put hashtags in the body -> not duplicated, capped set wins
    m = _compose("t", "great moment\n\n#office #jim", ["office", "jim"], ["office"])
    assert m["description"].count("#office") == 1
    assert m["description"].strip().endswith(m["hashtags"][-1])


def _resp(text: str):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=10, output_tokens=20),
    )


def test_live_uses_model_output_but_still_caps(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    log = AgentLog(tmp_path / "log.jsonl")
    payload = '{"description": "Dwight gets conditioned.", "hashtags": ["theoffice","jim","dwight","comedy"], "tags": ["the office","jim","dwight"]}'
    mock = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: _resp(payload)))
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock):
        m = build_youtube_metadata("Jim Trains Dwight", "He expects a mint.", log)
    assert "Dwight gets conditioned" in m["description"]
    assert m["hashtags"][0] == _SHORTS_TAG and len(m["hashtags"]) <= _MAX_HASHTAGS
    assert m["title"] == "Jim Trains Dwight #Shorts"


def test_stub_mode_uses_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("SHORTS_LLM", raising=False)
    log = AgentLog(tmp_path / "log.jsonl")
    m = build_youtube_metadata("A Great Office Moment", "Michael says something.", log)
    assert m["title"] == "A Great Office Moment #Shorts"
    assert _SHORTS_TAG in m["hashtags"]
