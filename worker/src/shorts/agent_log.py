"""JSONL log of agent activity (LLM calls and other notable actions) plus
token/cost accounting -- the audit trail for what each agent did and what
it cost."""

import json
import threading
from pathlib import Path

# ponytail: pricing constants -- update these when Anthropic pricing
# changes (platform.claude.com/docs/en/pricing). (input, output) cents per
# token. Priced per record off the payload's "model" (llm.py logs it on
# every llm_complete); records without a model fall back to sonnet list
# price, which keeps older logs' totals meaningful.
_PRICING_CENTS_PER_TOKEN = {
    "claude-sonnet-5": (3.0 * 100 / 1_000_000, 15.0 * 100 / 1_000_000),  # $3 / $15 per 1M
    "claude-haiku-4-5": (1.0 * 100 / 1_000_000, 5.0 * 100 / 1_000_000),  # $1 / $5 per 1M
}
_DEFAULT_PRICING = _PRICING_CENTS_PER_TOKEN["claude-sonnet-5"]


def _pricing_for(model: str | None) -> tuple[float, float]:
    if model:
        for prefix, pricing in _PRICING_CENTS_PER_TOKEN.items():
            if model.startswith(prefix):
                return pricing
    return _DEFAULT_PRICING


class AgentLog:
    """Appends JSONL records of agent activity to `path` and computes
    per-agent token/cost totals from them."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        # emit() is called concurrently once the Critic scores candidates in
        # parallel -- serialize the appends so records never interleave.
        self._lock = threading.Lock()

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
        line = json.dumps(record) + "\n"
        with self._lock, self.path.open("a") as f:
            f.write(line)

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
            in_price, out_price = _pricing_for(record.get("payload", {}).get("model"))
            entry["cost_cents"] += (
                record.get("tokens_in", 0) * in_price
                + record.get("tokens_out", 0) * out_price
            )
        return totals
