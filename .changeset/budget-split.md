---
"@frames-ag/tick": minor
---

split single `budget` into `llm_budget` + `tool_budget` so paid tools have a reserved spend floor

Today's runs showed the root cause of `settled=$0` across every curate: with a single $1.50 pot, LLM iteration cost (~$1.36 measured) consumes the budget before the agent ever reaches a `tool_invoke`. Sub-agents fan out and finish the rest. The agent never picks paid tools because it can't afford them.

`CurateOptions` now has two independent pots:
- **`llm_budget`** — LLM iterations + sub-agent LLM + web_fetch summarizer + citation verifier
- **`tool_budget`** — paid `tool_invoke` calls (the x402/MPP path)

Each cost-emitting site debits its own pot. The force-stop guard fires when **`llm_budget`** drops below the safety floor (or projected next-iter cost would). `tool_budget` is **NOT** a force-stop signal — it's a guaranteed floor; per-call exhaustion is handled at dispatch time (catalog_dispatch refuses calls whose `price_hint` exceeds `tool_remaining`).

### Default split

When only the legacy `budget` field is provided, the runtime splits **80% LLM / 20% tool**. A $1.50 budget becomes $1.20 LLM + $0.30 tool — that floor of $0.30 is what guarantees the agent can pay for catalog calls even after a long LLM-heavy run.

When `llm_budget` and `tool_budget` are passed explicitly (via `CurateOptions` direct usage), they override the split entirely.

### System prompt

The agent now sees both pots in the system prompt and is told explicitly that `tool_budget` can't be used for LLM iterations — "if you skip catalog tools to save budget, you'll be force-stopped with USDC unspent."

### Compatibility

- `CurateOptions.budget` stays optional; legacy callers passing `budget` still work via the 80/20 default split.
- New optional fields `llm_budget` / `tool_budget` in `CurateOptions`.
- New optional fields `llm_budget_remaining` / `tool_budget_remaining` in the run receipt's report. `budget_remaining` is preserved (now reports sum of both pots).
- `CurateSystemArgs.budget` was replaced by `llm_budget` + `tool_budget` (breaking for anyone building the system prompt directly outside tick — not a public API).

### Not in scope

- `DiscoverOptions` still uses the single-pot model. Mirror change can ship as a follow-up if/when discover-flow runs need the same protection.
- `RunInput` HTTP body still accepts only `budget` — splitting via the wire API can ship once the curate-side split has been validated live.
