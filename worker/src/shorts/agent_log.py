"""JSONL log of agent activity (LLM calls and other notable actions) plus
token/cost accounting -- the audit trail for what each agent did and what
it cost."""

import json
from pathlib import Path

# ponytail: pricing constants -- update these when Anthropic pricing
# changes. Current claude-sonnet-5 pricing (see claude-api skill /
# platform.claude.com/docs/en/pricing): $3.00 per 1M input tokens, $15.00
# per 1M output tokens (list price; a $2/$10 introductory rate applies
# through 2026-08-31, not modeled here -- swap these if/when it matters).
PRICE_CENTS_PER_INPUT_TOKEN = 3.0 * 100 / 1_000_000  # $3/1M tokens -> cents/token
PRICE_CENTS_PER_OUTPUT_TOKEN = 15.0 * 100 / 1_000_000  # $15/1M tokens -> cents/token


class AgentLog:
    """Appends JSONL records of agent activity to `path` and computes
    per-agent token/cost totals from them."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def emit(
        self,
        agent: str,
        action: str,
        payload: dict,
        tokens_in: int = 0,
        tokens_out: int = 0,
    ) -> None:
        record = {
            "agent": agent,
            "action": action,
            "payload": payload,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }
        with self.path.open("a") as f:
            f.write(json.dumps(record) + "\n")

    def totals(self) -> dict[str, dict]:
        """Per-agent tokens and estimated cost (cents) at current pricing."""
        totals: dict[str, dict] = {}
        if not self.path.exists():
            return totals
        for line in self.path.read_text().splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            entry = totals.setdefault(
                record["agent"], {"tokens_in": 0, "tokens_out": 0, "cost_cents": 0.0}
            )
            entry["tokens_in"] += record.get("tokens_in", 0)
            entry["tokens_out"] += record.get("tokens_out", 0)
            entry["cost_cents"] = (
                entry["tokens_in"] * PRICE_CENTS_PER_INPUT_TOKEN
                + entry["tokens_out"] * PRICE_CENTS_PER_OUTPUT_TOKEN
            )
        return totals
