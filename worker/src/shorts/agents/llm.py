"""Thin wrapper over the Anthropic SDK: one schema-validated JSON completion
per call, with a single retry when the model's response isn't valid JSON or
doesn't match the schema. SHORTS_LLM=stub (the default -- no API key
needed) short-circuits every call by raising StubModeError; callers catch
it and fall back to their deterministic, no-LLM path. This is what makes
`--llm stub` a full run with zero network access."""

import json
import os

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


def complete_json(prompt: str, schema: dict, agent: str, log: AgentLog) -> dict:
    """Complete `prompt` via the Anthropic API and return JSON matching
    `schema`. Retries once if the model's response is invalid JSON or fails
    the schema check; raises LlmError if the retry also fails. Every
    attempt (successful or not) is logged via `log.emit` with its token
    counts. Raises StubModeError immediately if SHORTS_LLM is unset or
    "stub" -- no network call is made in that mode."""
    if os.environ.get("SHORTS_LLM", "stub") == "stub":
        raise StubModeError(f"SHORTS_LLM=stub -- {agent} must use its deterministic path")

    model = os.environ.get("SHORTS_LLM_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic()

    last_error = "unknown error"
    for attempt in range(2):
        response = client.messages.create(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        log.emit(
            agent,
            "llm_complete",
            {"attempt": attempt, "model": model},
            tokens_in=response.usage.input_tokens,
            tokens_out=response.usage.output_tokens,
        )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            last_error = f"invalid JSON: {e}"
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
