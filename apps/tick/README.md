# tick

Hosted runtime for [frame](../../packages/frame) datasets. Managed wallet + tool catalog injection. Four ops — `verify` / `refresh` / `curate` / `discover` — billed via x402 / MPP in USDC, settled per-call by `upto` ceiling. Wallet IS the identity. No API keys to manage.

Implements [frames-cloud](../frames-cloud) Tier 3 item 15 — the "heartbeat / refresh runtime" that re-fetches sources, attaches fresh evidence, deprecates stale facts, and posts events back to the customer's frame.

## Operations

| Op | What it does | Frame events | Default budget (USDC) |
|---|---|---|---|
| `verify` | Read-only re-fetch of every fact's `source.url`. Classifies drift across five kinds. | none | 0.15 |
| `refresh` | `verify` iteration + emits `fact.deprecated` for dead/drifted sources, `evidence.attached` for redirects. | yes (deprecate, attach) | 0.30 |
| `curate` | Full agent loop with 9 tools — frame mutations + catalog-mediated tool discovery + LLM-driven reasoning. | yes (entity.created, fact.set, facts.set_many, …) | 1.50 |
| `discover` | Search-only candidate proposer. Returns `report.candidates[]` for human review. | none | 0.50 |

Customer pays only what's consumed (`upto` settle). Defaults are recommendations; pass an explicit `budget` to override.

## HTTP API

```
POST /run
  Authorization: Bearer <wallet-session-token>     (or x402 Payment header in production)
  Content-Type: application/json
  Idempotency-Key: <uuid>                          (optional — replays terminal results)
  Accept: text/event-stream                        (optional — switches to SSE response)
  Body: { op, frame, budget?, params? }

GET    /runs/:id            → full receipt: run + events (parsed) + tool_log
DELETE /runs/:id            → mark in-flight run as aborted (best-effort)
GET    /history?address=W   → list runs by wallet (TODO: real CAIP-122 SIWX gating)
DELETE /history?address=W   → GDPR purge. With FACILITATOR_URL set, requires verified payer == W
GET    /balance             → wallet config summary
GET    /health              → { ok, ts, db, wallets, payments, llm }
```

`frame` is a github.com URL: `https://github.com/<user>/<repo>[/<frame_path>]`.

**SSE response shape** (when `Accept: text/event-stream`):

```
event: started      { run_id, op, frame, agent, budget, started_at }
event: frame_event  { id, ts, type, agent, run_id, payload }    ← one per event the op produces
event: heartbeat    { ts, run_id }                              ← every 5s
event: completed    { run_id, op, frame, settled, events[], tool_log[], summary, … }
event: error        { error: { code, message }, status, … }
```

## MCP server

Add to your `.mcp.json` to expose tick's ops as tools to any MCP-aware harness (opencode, Claude Code, Codex CLI, Cursor):

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

Four tools appear: `runtime.curate`, `runtime.refresh`, `runtime.verify`, `runtime.discover`. Each is a thin proxy that POSTs to `/run` with the right shape.

## Install

```bash
# One-shot:
npx -y @frames-ag/tick verify <frame-url>

# Or install globally:
npm i -g @frames-ag/tick
tick verify <frame-url>
```

Node ≥ 22 required. Works with any MCP-aware harness (opencode, Claude Code, Codex CLI, Cursor) — see the MCP server section below.

## CLI

```bash
npx -y @frames-ag/tick verify https://github.com/microchipgnu/frames-examples/datasets/mcp-servers
npx -y @frames-ag/tick refresh datasets/foo --budget 0.30
npx -y @frames-ag/tick curate datasets/foo --budget 1.50
npx -y @frames-ag/tick mcp                    # stdio MCP server
```

CLI brings its own wallet (env-loaded `SOLANA_OUTBOUND_KEYPAIR_JSON` / `EVM_OUTBOUND_PRIVATE_KEY`). It does **not** call the hosted endpoint — outbound paid calls go directly to each tool's seller-side facilitator. Zero infrastructure dependency on `tick.frames.ag`.

## Local development

```bash
# Install workspace deps from the monorepo root
bun install

# Type-check
bun run typecheck

# Unit tests (43 tests, ~20ms)
bun run test

# Smoke test the local Bun dev server
bun run smoke

# Boot the dev server (port 8788)
bun run dev

# Boot via Cloudflare's local runtime (Miniflare-emulated D1 etc.)
bun run dev:cloudflare

# Build the npm-publishable bundle
bun run build  # → dist/cli.js with Node shebang
```

To validate the full pipeline locally:

```bash
# Terminal 1
cd ../frames-cloud && bun --hot src/index.ts  # serves on :8787

# Terminal 2
cd apps/tick && FRAMES_CLOUD_BASE=http://localhost:8787 bun run smoke
```

You should see the verify case succeed with a real drift report against `microchipgnu/ai-agent-wallets-eu`.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers via `agents` SDK + Hono |
| LLM routing | Cloudflare AI Gateway with BYOK aliases (the Stripe-style pattern: gateway holds provider keys; tick references them) |
| Outbound payment | `@faremeter/fetch wrap()` auto-negotiating x402 v1/v2 + MPP across Solana + Base + Tempo. `@frames-ag/payment-tempo` plugs Tempo MPP into the same wrap. |
| Wallet custody | Self-custody, env-loaded keys (`SOLANA_OUTBOUND_KEYPAIR_JSON`, `EVM_OUTBOUND_PRIVATE_KEY`). EVM key serves Base x402 + Tempo MPP. |
| Frame state read | [frames-cloud](../frames-cloud) REST resolver — works on any public GitHub repo with `schema.yml` |
| Frame state write | Return events in `/run` response body; customer's CI commits (Mode 1). Mode 2 (hosted via GitHub App) is post-alpha. |
| Tool discovery | Catalog-mediated via [catalog.frames.ag](https://catalog.frames.ag) (5,797 descriptors) — `catalog_search` → `tool_invoke` |
| Receipts | D1: `runs` / `tool_calls` / `events`, all joined by `run_id`. Cascade-delete, sliding-window queries for rate limit. |
| Rate limits | Sliding window (60s + 3600s) per IP-hashed identity. Swaps to wallet address when SIWX lands. |

## Required secrets

The hosted `/run` endpoint is **closed by default** — set `TICK_ALLOWED_AGENTS` before any customer can reach it. See [DEPLOY.md §1d](./DEPLOY.md) for the allowlist syntax.

# 🔑 Bearer-token API keys (recommended for closed alpha).
# Comma-separated `<key>:<agent-identifier>` pairs. Customer sends
# `Authorization: Bearer <key>`; server maps to the agent identifier.
# A Bearer that doesn't match a configured key 401s immediately.
wrangler secret put TICK_API_KEYS                   # → e.g. `k_alpha1:frames-runtime:0xA,k_alpha2:frames-runtime:0xB`

# 🚪 Agent allowlist — REQUIRED for hosted /run to accept any caller.
# Whitelists the agent identifier (after TICK_API_KEYS lookup or x402 verify).
# Use `*` to open the gate (only safe once x402 billing is wired in Phase B).
wrangler secret put TICK_ALLOWED_AGENTS             # → e.g. `frames-runtime:0xA,frames-runtime:0xB`

# Outbound wallets — only if curate/discover will make paid tool calls.
# verify/refresh don't need them.
wrangler secret put SOLANA_OUTBOUND_KEYPAIR_JSON   # 64-byte JSON array
wrangler secret put EVM_OUTBOUND_PRIVATE_KEY       # 0x-hex secp256k1
wrangler secret put SOLANA_RPC_URL                  # mainnet-beta or private RPC

# LLM auth — pick one mode:
# (a) BYOK — gateway holds provider keys (recommended, Stripe-style)
wrangler secret put AI_GATEWAY_URL                  # https://gateway.ai.cloudflare.com/v1/<account>/<gateway>
wrangler secret put AI_GATEWAY_BYOK_ALIAS           # alias name from CF dashboard
wrangler secret put AI_GATEWAY_TOKEN                # optional gateway Bearer

# (b) Passthrough — dev / no gateway
wrangler secret put ANTHROPIC_API_KEY

# Audit-receipt signing (optional, recommended)
# Without this, tool.invoked receipts ship with signature: ""
wrangler secret put AUDIT_PRIVATE_KEY               # 32-byte ed25519 seed: hex or base64url

# Facilitator — Phase A skips it. Set this only when adding x402 billing
# in Phase B (CDP or self-hosted Faremeter).
# wrangler secret put FACILITATOR_URL               # https://api.cdp.coinbase.com/x402
```

Wallet keygen scripts at [`../tick-facilitator/scripts/`](../tick-facilitator/scripts/). Fund each outbound address with ~$10 USDC + a small native gas reserve before any paid-tool runs.

## Operator docs

- [DEPLOY.md](./DEPLOY.md) — full clone-to-live runbook (facilitator + runtime + day-2 ops + failure modes)
- [MIGRATION.md](./MIGRATION.md) — guide for moving an `opencode`-based curation workflow to tick
- [CHANGELOG.md](./CHANGELOG.md) — what shipped per version
- [PLAN.md §9](./PLAN.md#9-build-plan--status-as-of-2026-05-11) — full sprint-by-sprint status with ✅ / ⏳ markers

## Status

Code-only work is functionally complete (2026-05-11). External-auth items (facilitator deploy, wallet funding, real-money validation, npm publish) are next-step operator work — see [DEPLOY.md](./DEPLOY.md).

## Sibling apps + packages

- [`apps/tick-facilitator/`](../tick-facilitator) — self-hosted Faremeter facilitator on CF Containers (x402 / MPP verify+settle)
- [`apps/frames-cloud/`](../frames-cloud) — read API for frame datasets (tick's read mirror)
- [`apps/catalog/`](../catalog) — federated tool catalog (the runtime's tool source)
- [`packages/frame/`](../../packages/frame) — frame protocol + CLI + curation MCP
- [`packages/pay/`](../../packages/pay) — buyer-side paid-call protocol (ToolDescriptor + Wallet)
- [`packages/payment-tempo/`](../../packages/payment-tempo) — MPP Tempo charge client for Faremeter
- [`packages/tick-types/`](../../packages/tick-types) — shared wire types
