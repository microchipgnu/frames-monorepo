---
name: tick
version: 0.0.0
description: Hosted runtime for frame datasets. Four ops — curate, refresh, verify, discover — billed via x402/MPP in USDC. Wallet IS the identity.
homepage: https://tick.frames.ag
metadata: {"moltbot":{"category":"agent-runtime","api_base":"https://tick.frames.ag"},"frame":{"protocol":"0.2.0","write_tools":["add_entity_with_facts","set_facts","deprecate_fact","attach_evidence"],"events":["entity.created","fact.set","facts.set_many","fact.deprecated","evidence.attached","entity.removed","tool.invoked"]},"payment":{"protocols":["x402","x402v2","mpp"],"chains":["solana","base","tempo"],"settlement":"USDC"},"mcp":{"server":"npx -y @frames-ag/tick mcp","tools":["runtime.curate","runtime.refresh","runtime.verify","runtime.discover"]}}
---

# tick

`tick` is the hosted runtime layer for [frame](https://github.com/frames-engineering/frame) datasets. Point it at a frame URL and it will read, fetch, verify, and write evidence-backed facts on your behalf — billed per call in USDC, wallet-signed, no API keys.

Four operations:

| Op | What it does | Default budget (USDC) |
|---|---|---|
| `curate` | Full agent loop: read state, search sources, write facts with evidence | 1.50 |
| `refresh` | Re-fetch every fact's source.url; deprecate dead sources, attach redirects | 0.30 |
| `verify` | Read-only: re-fetch sources, report drift. No writes. | 0.15 |
| `discover` | Search-only: propose candidate entities for human review | 0.50 |

Customer pays `upto` budget; settles actual consumed.

---

## TL;DR — Quick Reference

**Frame URL format:** `https://github.com/<user>/<repo>[/<frame_path>]`

**Just want the cheapest answer?** Use `verify` — pure read, never mutates.

**Want your dataset updated?** Use `refresh` (fixes link rot) or `curate` (adds new entities).

**Authentication:** wallet signature on the inbound x402 challenge. No API keys to manage.

---

## Two integration paths

### Path 1 — MCP server (recommended for harnesses)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "tick": {
      "command": "npx",
      "args": ["-y", "@frames-ag/tick", "mcp"],
      "env": {
        "TICK_API_URL": "https://tick.frames.ag",
        "TICK_API_KEY": "<wallet-session-token>"
      }
    }
  }
}
```

Then the four tools appear in any MCP-aware harness (opencode, Claude Code, Codex CLI, Cursor):

- `runtime.curate({ frame, budget? })` → events + run_id + settled cost
- `runtime.refresh({ frame, budget? })` → events + drift report + run_id
- `runtime.verify({ frame, budget? })` → drift report + run_id
- `runtime.discover({ frame, budget? })` → candidate entities for review

### Path 2 — Direct HTTP

```bash
curl -s -X POST "https://tick.frames.ag/run" \
  -H "Authorization: Bearer ${TICK_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "op": "verify",
    "frame": "https://github.com/microchipgnu/frames-examples/datasets/mcp-servers",
    "budget": "0.15"
  }'
```

Response shape (success):

```json
{
  "run_id": "run_a1b2c3...",
  "op": "verify",
  "frame": "https://github.com/microchipgnu/frames-examples/datasets/mcp-servers",
  "settled": "0.087",
  "events": [],
  "tool_log": [
    {
      "seq": 0,
      "descriptor_id": "tick:paid-refetcher",
      "tool_id": "tick.paid.fetch",
      "cost": "0.01",
      "source_url": "https://api.github.com/repos/...",
      "retrieved_at": "2026-05-11T16:01:54Z"
    }
  ],
  "summary": "verify · mcp_servers@a1b2c3d · 13 entities, 47 fields checked · 36 verified, 11 drifts · $0.063 remaining",
  "started_at": "2026-05-11T16:01:00Z",
  "ended_at": "2026-05-11T16:01:54Z",
  "report": { "drifts": [...], "stats": {...} }
}
```

---

## When to use which op

### `curate` — full agent loop (paid LLM + paid tools)

Use when:
- New entities need to be discovered + added to the dataset
- A daily tick that does discovery + refresh in one shot
- You have a `prompt.md` describing the loop and want it executed end-to-end

Cost shape: 30+ LLM calls + 10+ paid tool calls is typical. Default $1.50 budget covers P50 cycles; bump for discovery-heavy runs.

### `refresh` — re-verify and mutate

Use when:
- You want to detect link rot and emit `fact.deprecated` events
- You want to attach redirect-destination evidence to existing facts
- A cheap weekly tick to keep facts honest

No LLM cost. Tool cost varies with how many fields you have.

### `verify` — read-only drift report

Use when:
- You want a drift report without writes
- Quick sanity check before deciding to `refresh`
- CI gate that says "this dataset is still well-sourced"

Cheapest op. Returns structured drifts (`source_dead` / `value_drift` / `excerpt_missing` / `source_redirect`).

### `discover` — propose new entities

Use when:
- You want candidates surfaced but reviewed by a human before commit
- Doing a search-heavy initial seed for a fresh frame
- Bounded "find me 5 more" without trusting the agent to write directly

Returns candidates with evidence; writes go to a review queue, not the frame.

---

## How payment works

Two modes, both settled in USDC, wallet-native:

- **`/run`** = single-shot x402 `upto` — verify+settle in one call. Best for `verify`/`refresh`/most `curate` ops.
- **`/session`** = multi-turn MPP — pre-authorize a cap, stream charges, settle on close. Best for long `curate` runs or stateful work.

Tick supports both protocols transparently. Solana + Tempo MPP work today (via `payment-tempo`). x402 works on Solana + Base. No Stripe dependency.

---

## Receipts (the join story)

Every run produces a `run_id`. The receipt at `GET /runs/<run_id>` is publicly queryable by run_id possession. The receipt contains:

- All frame events written during the run (with `run_id` baked into each envelope per frame protocol v0.2.0)
- All paid tool calls with source URLs, costs, and timestamps
- Total settled amount

**Anyone reading the customer's frame can join `events.ndjson` to our run log by `run_id`** — see exactly which paid tool produced each source URL, at what cost, when. This is what makes "evidence-tracked" verifiable.

---

## Failure handling

- **Source dead** during refresh: emit `fact.deprecated`, settle the part of the budget consumed
- **Tool fails** mid-curate: agent receives an error tool_result, may retry with a different tool
- **Budget exhausted**: agent gets a system message asking it to wrap up; loop force-stops
- **Frame unreachable** (frames-cloud can't resolve): run returns 4xx, no payment settled

`upto` semantics mean you never pay more than your declared budget. Partial completion settles for the partial amount.

---

## Rate limits

Per-wallet rate limits applied at the gateway. SIWX-gated read endpoints (`/runs/<id>`, `/history`, `/balance`) are free up to per-wallet limits. Paid ops carry their own internal rate-limiting on the agent loop side (max iterations, max tool calls per turn).

---

## Tips

- **Bulk-write whenever atomic.** If you can compute many fields from one source, use a single `add_entity_with_facts` or `set_facts` call. Emits a single `facts.set_many` event instead of N — cleaner audit log, fewer events.
- **Cite real sources.** The runtime rejects facts without `source.url + source.retrieved_at`. Don't invent URLs.
- **Use `excerpt` liberally.** A verbatim quote in `source.excerpt` is the single biggest signal-to-noise improvement for downstream `verify` runs.
- **Migrate from opencode/Claude Code:** swap your `OPENROUTER_API_KEY` env var for `TICK_API_KEY` and replace `opencode run` with `npx @frames-ag/tick curate <frame-url>`. Same prompt.md, same dataset, just paid via wallet instead of API key.

---

## Related skills

- [`agentwallet`](https://github.com/frames-engineering/skills/tree/main/skills/agentwallet) — provision the wallet you use to authenticate
- [`registry`](https://github.com/frames-engineering/skills/tree/main/skills/registry) — frames registry for paid tool discovery (tick uses this internally via the catalog)
- [`analysis`](https://github.com/microchipgnu/blindspot.news/tree/main/skills/analysis) — philosophical analysis framework used by blindspot.news (one of tick's canonical workloads)

---

## Roadmap

- `curate` and `discover` ops (live as of 2026-05-11; classification quality improves week-on-week)
- Per-tier MCP scoping (each dataset declares its tool needs at boot)
- Multi-provider model routing (OpenAI, Gemini, open models via AI Gateway BYOK)
- Sandbox integration for code-running tools inside `curate`
- Per-session sub-wallets for stronger custody isolation

See [PLAN.md](https://github.com/frames-engineering/frames-monorepo/blob/main/apps/tick/PLAN.md) for the full build state.
