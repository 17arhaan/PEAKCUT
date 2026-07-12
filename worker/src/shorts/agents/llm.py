"""Thin wrapper over the Anthropic SDK: one schema-validated JSON completion
per call, with a single retry when the model's response isn't valid JSON or
doesn't match the schema. SHORTS_LLM=stub (the default -- no API key
needed) short-circuits every call by raising StubModeError; callers catch
it and fall back to their deterministic, no-LLM path. This is what makes
`--llm stub` a full run with zero network access."""

import json
import os
import re

import anthropic

from shorts.agent_log import AgentLog

DEFAULT_MODEL = "claude-sonnet-5"

# ponytail: hand-rolled required-keys/type check rather than a jsonschema
# dependency -- the schemas this gate needs are a small, flat subset (top-
# level "required" + "properties" with primitive/array/object "type").
_JSON_TYPES: dict[str, type | tuple[type, ...]] = {
    "object": dict,
    "array": list,
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "null": type(None),
}


class LlmError(Exception):
    """Raised when the LLM never returns schema-valid JSON, even after one retry."""


class StubModeError(Exception):
    """Raised whenever SHORTS_LLM is unset or "stub" (the default) -- the
    caller must use its deterministic, non-LLM path instead of calling out."""


def _validate_schema(data: object, schema: dict) -> bool:
    if not isinstance(data, dict):
        return False
    for key in schema.get("required", []):
        if key not in data:
            return False
    for key, spec in schema.get("properties", {}).items():
        if key not in data:
            continue
        want = _JSON_TYPES.get(spec.get("type"))
        if want is not None and not isinstance(data[key], want):
            return False
    return True


def _extract_json(raw: str) -> str:
    """Pull the JSON out of a real model reply, which may wrap it in markdown
    ```json fences or surround it with prose. Falls back to the raw text.

    ponytail: string surgery, not a full parser; the loud json.loads failure
    still catches anything this misses."""
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```\s*$", "", s).strip()
    if s[:1] not in "{[":
        starts = [i for i in (s.find("{"), s.find("[")) if i != -1]
        if starts:
            start = min(starts)
            end = s.rfind("}" if s[start] == "{" else "]")
            if end > start:
                s = s[start : end + 1]
    return s


def complete_json(prompt: str, schema: dict, agent: str, log: AgentLog) -> dict:
    """Complete `prompt` via the Anthropic API and return JSON matching
    `schema`. Retries once if the model's response is invalid JSON or fails
    the schema check; raises LlmError if the retry also fails. Every
    attempt (successful or not) is logged via `log.emit` with its token
    counts. Raises StubModeError immediately unless SHORTS_LLM is exactly
    "live" -- unset, "stub", or any typo/other value all stay in stub mode
    (fail closed rather than accidentally going live on a mistyped env var),
    so no network call is made in that mode."""
    if os.environ.get("SHORTS_LLM", "stub") != "live":
        raise StubModeError(f"SHORTS_LLM != live -- {agent} must use its deterministic path")

    model = os.environ.get("SHORTS_LLM_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic()

    last_error = "unknown error"
    # Escalating budgets: claude-sonnet-5 can lead with a thinking block, which
    # on a large transcript chunk consumes the whole budget and truncates BEFORE
    # the JSON text block is emitted (stop_reason="max_tokens", no text block).
    # A bigger ceiling on retry gives thinking + JSON room to both fit.
    max_tokens_per_attempt = (8192, 16384)
    for attempt in range(2):
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens_per_attempt[attempt],
            messages=[{"role": "user", "content": prompt}],
        )
        # A response may lead with a ThinkingBlock (extended thinking); the
        # JSON we want is in the first *text* block, not necessarily content[0].
        text = next(
            (b.text for b in response.content if getattr(b, "type", None) == "text"),
            None,
        )
        if text is None or not text.strip():
            stop = getattr(response, "stop_reason", None)
            last_error = f"empty/no text block (stop_reason={stop} — likely truncated during thinking)"
            continue
        log.emit(
            agent,
            "llm_complete",
            {"attempt": attempt, "model": model},
            tokens_in=response.usage.input_tokens,
            tokens_out=response.usage.output_tokens,
        )
        candidate = _extract_json(text)
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError as e:
            last_error = f"invalid JSON: {e}; head={candidate[:120]!r}"
            prompt = (
                f"{prompt}\n\nYour previous response was not valid JSON ({e}). "
                "Respond with ONLY valid JSON matching the requested schema."
            )
            continue
        if not _validate_schema(data, schema):
            last_error = f"response did not match schema (required: {schema.get('required')})"
            prompt = (
                f"{prompt}\n\nYour previous response did not match the required schema "
                f"(required keys: {schema.get('required')}). "
                "Respond with ONLY valid JSON matching the schema."
            )
            continue
        return data

    raise LlmError(f"{agent}: no schema-valid JSON after retry: {last_error}")
