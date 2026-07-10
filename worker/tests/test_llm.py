"""Tests for the LLM plumbing (llm.py) and the agent activity log
(agent_log.py). The SDK client object itself is mocked -- no HTTP -- so
these run offline and fast; the one real-network case is the `live`-marked
smoke test, which is skipped unless SHORTS_LLM=live and an API key are both
present (neither is true on this machine, so it's pending a key)."""

import json
import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from shorts.agent_log import AgentLog
from shorts.agents.llm import LlmError, StubModeError, complete_json


def _response(text: str, tokens_in: int = 10, tokens_out: int = 20):
    return SimpleNamespace(
        content=[SimpleNamespace(text=text)],
        usage=SimpleNamespace(input_tokens=tokens_in, output_tokens=tokens_out),
    )


SCHEMA = {"required": ["evidence"], "properties": {"evidence": {"type": "array"}}}


def test_stub_mode_raises_stub_mode_error(tmp_path, monkeypatch):
    monkeypatch.delenv("SHORTS_LLM", raising=False)
    log = AgentLog(tmp_path / "log.jsonl")
    with pytest.raises(StubModeError):
        complete_json("prompt", SCHEMA, "scout", log)


def test_explicit_stub_mode_raises_stub_mode_error(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "stub")
    log = AgentLog(tmp_path / "log.jsonl")
    with pytest.raises(StubModeError):
        complete_json("prompt", SCHEMA, "scout", log)


def test_valid_json_first_try_returns_parsed_dict(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    log = AgentLog(tmp_path / "log.jsonl")
    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: _response('{"evidence": []}'))
    )
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock_client):
        result = complete_json("prompt", SCHEMA, "scout", log)
    assert result == {"evidence": []}


def test_retries_once_on_invalid_json_then_succeeds(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    log = AgentLog(tmp_path / "log.jsonl")
    responses = iter([_response("not json at all"), _response('{"evidence": [1]}')])
    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: next(responses))
    )
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock_client):
        result = complete_json("prompt", SCHEMA, "scout", log)
    assert result == {"evidence": [1]}

    records = [json.loads(line) for line in log.path.read_text().splitlines()]
    assert len(records) == 2
    assert [r["payload"]["attempt"] for r in records] == [0, 1]
    assert all(r["agent"] == "scout" for r in records)
    assert all(r["tokens_in"] == 10 and r["tokens_out"] == 20 for r in records)


def test_retry_reprompt_includes_validation_error_and_correct_structure(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    log = AgentLog(tmp_path / "log.jsonl")
    call_kwargs = []
    responses = iter([_response("not json at all"), _response('{"evidence": []}')])

    def capture_create(**kw):
        call_kwargs.append(kw)
        return next(responses)

    mock_client = SimpleNamespace(messages=SimpleNamespace(create=capture_create))
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock_client):
        result = complete_json("prompt", SCHEMA, "scout", log)
    assert result == {"evidence": []}

    # Verify second call's kwargs
    assert len(call_kwargs) == 2
    second_call_kw = call_kwargs[1]
    # Check messages structure
    assert "messages" in second_call_kw
    assert isinstance(second_call_kw["messages"], list)
    assert len(second_call_kw["messages"]) == 1
    assert second_call_kw["messages"][0]["role"] == "user"
    assert isinstance(second_call_kw["messages"][0]["content"], str)
    # Check that re-prompt includes the validation error text
    assert "not valid JSON" in second_call_kw["messages"][0]["content"]
    # Check max_tokens is present and correct
    assert second_call_kw.get("max_tokens") == 4096


def test_retries_once_on_schema_mismatch_then_succeeds(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    log = AgentLog(tmp_path / "log.jsonl")
    responses = iter([_response('{"wrong_key": 1}'), _response('{"evidence": [1]}')])
    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: next(responses))
    )
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock_client):
        result = complete_json("prompt", SCHEMA, "scout", log)
    assert result == {"evidence": [1]}


def test_raises_llm_error_after_exhausting_retry(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    log = AgentLog(tmp_path / "log.jsonl")
    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: _response("still not json"))
    )
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock_client):
        with pytest.raises(LlmError):
            complete_json("prompt", SCHEMA, "scout", log)

    records = [json.loads(line) for line in log.path.read_text().splitlines()]
    assert len(records) == 2  # one attempt + one retry, both logged before raising


def test_model_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTS_LLM", "live")
    monkeypatch.setenv("SHORTS_LLM_MODEL", "claude-custom-test-model")
    log = AgentLog(tmp_path / "log.jsonl")
    seen_models = []

    def create(**kw):
        seen_models.append(kw["model"])
        return _response('{"evidence": []}')

    mock_client = SimpleNamespace(messages=SimpleNamespace(create=create))
    with patch("shorts.agents.llm.anthropic.Anthropic", return_value=mock_client):
        complete_json("prompt", SCHEMA, "scout", log)
    assert seen_models == ["claude-custom-test-model"]


# --- AgentLog --------------------------------------------------------


def test_agent_log_emit_appends_jsonl(tmp_path):
    log = AgentLog(tmp_path / "log.jsonl")
    log.emit("scout", "llm_complete", {"attempt": 0}, tokens_in=100, tokens_out=50)
    log.emit("critic", "llm_complete", {"attempt": 0}, tokens_in=200, tokens_out=75)

    lines = log.path.read_text().splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["agent"] == "scout"
    assert first["action"] == "llm_complete"
    assert first["tokens_in"] == 100
    assert first["tokens_out"] == 50


def test_agent_log_totals_arithmetic(tmp_path):
    log = AgentLog(tmp_path / "log.jsonl")
    log.emit("scout", "llm_complete", {}, tokens_in=1_000_000, tokens_out=1_000_000)
    log.emit("scout", "llm_complete", {}, tokens_in=1_000_000, tokens_out=1_000_000)
    log.emit("critic", "llm_complete", {}, tokens_in=500_000, tokens_out=0)

    totals = log.totals()

    assert totals["scout"]["tokens_in"] == 2_000_000
    assert totals["scout"]["tokens_out"] == 2_000_000
    # 2M input tokens @ $3/1M + 2M output tokens @ $15/1M = $6 + $30 = $36 = 3600 cents
    assert totals["scout"]["cost_cents"] == pytest.approx(3600.0)

    assert totals["critic"]["tokens_in"] == 500_000
    assert totals["critic"]["cost_cents"] == pytest.approx(150.0)  # 0.5M @ $3/1M = $1.50


def test_agent_log_totals_empty_when_no_file(tmp_path):
    log = AgentLog(tmp_path / "does_not_exist.jsonl")
    assert log.totals() == {}


# --- live smoke ---------------------------------------------------------


@pytest.mark.live
@pytest.mark.skipif(
    os.environ.get("SHORTS_LLM") != "live" or not os.environ.get("ANTHROPIC_API_KEY"),
    reason="requires SHORTS_LLM=live and a real ANTHROPIC_API_KEY",
)
def test_live_smoke_scout_schema(tmp_path):
    """One real Claude call with the Scout evidence schema -- asserts the
    parsed JSON carries a well-formed `evidence` array. Not run in CI/dev
    without a live key; pending a key per the controller."""
    log = AgentLog(tmp_path / "log.jsonl")
    schema = {
        "required": ["evidence"],
        "properties": {"evidence": {"type": "array"}},
    }
    prompt = (
        "Respond with ONLY a JSON object of the form "
        '{"evidence": [{"kind": "quote", "t": 1.0, "value": "hello"}]}. '
        "No prose, no markdown fences."
    )
    result = complete_json(prompt, schema, "scout", log)
    assert isinstance(result.get("evidence"), list)
