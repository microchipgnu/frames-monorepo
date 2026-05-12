# tick — operator deploy runbook

> **v1 happy path: skip the facilitator.** The CLI and hosted endpoint both
> ship without our own facilitator. Hosted is gated by an explicit agent
> allowlist (`TICK_ALLOWED_AGENTS`); revenue collection is Phase B with
> Coinbase CDP or self-hosted Faremeter. The `apps/tick-facilitator/` deploy
> stays in this repo but is **only needed when** a customer wants Solana,
> MPP-Tempo, or x402 settlement we control end-to-end.
>
> The §below sequence reflects that: Phase A is CLI + hosted with no
> facilitator. Phase B is "add billing" once demand is real.

---

## Phase A — CLI + hosted v1 (≈ 2 hours)

End-to-end: from clone to a live hosted endpoint your alpha customers can
use, with no facilitator and no funded EIP-3009 wallet.

### 0. Prerequisites

- Cloudflare account with **Workers Paid** ($5/mo plan) — D1 + Durable Objects
- `wrangler` ≥ 4.0 (`bunx wrangler --version`)
- `bun` ≥ 1.3
- Anthropic API key OR a configured Cloudflare AI Gateway with a BYOK alias
- A Solana mainnet RPC URL (Helius / Triton / QuickNode) **only if** you want
  curate/discover to run paid outbound tool calls; verify/refresh don't need it
- **No wallets to fund for inbound payments** — the facilitator is skipped
- Outbound wallets are still needed if you want paid tool calls, but they can
  be funded with $10 USDC each to start

---

## 1. One-time provisioning

### 1a. Outbound wallets (only if `curate`/`discover` will run paid tool calls)

`verify` and `refresh` don't need a wallet — they only do HTTP refetches.
Skip this step if you're alpha-testing those ops first.

```bash
cd apps/tick-facilitator
bun run gen:solana       # prints keypair JSON to stdout — pipe into secret
bun run gen:evm          # prints 0x-hex private key
```

Fund each with $10 USDC + a small native gas reserve. These pay catalog
tools, **not** the facilitator (which we're skipping in v1).

- Solana wallet → SOL for fees + USDC for tool calls
- EVM wallet → ETH on Base + USDC for tool calls (same key serves Tempo MPP)

### 1b. D1 database

The receipts database is **already provisioned** (`tick-receipts`, id pinned in
`apps/tick/wrangler.toml`). If you're forking, you'll need a fresh one:

```bash
cd apps/tick
bunx wrangler d1 create tick-receipts
# → paste the database_id into wrangler.toml under [[d1_databases]]
bunx wrangler d1 migrations apply tick-receipts --remote
```

For local dev:

```bash
bunx wrangler d1 migrations apply tick-receipts --local
```

### 1c. Audit-signing key (optional, recommended)

```bash
# 32-byte ed25519 seed (hex). Used to sign every tool.invoked receipt so
# offline verifiers can confirm provenance. Without this, receipts ship
# unsigned (signature: "").
openssl rand -hex 32 | bunx wrangler secret put AUDIT_PRIVATE_KEY
```

### 1d. Customer auth — bearer-token + allowlist

The hosted `/run` endpoint is **closed by default**. Two secrets together:

#### TICK_API_KEYS (recommended for closed alpha)

Stable identity for each customer — they get an opaque API key, you keep
the mapping. Survives CI runner IP rotation.

```bash
# Generate one key per customer (32-byte hex is plenty):
KEY_ALICE=$(openssl rand -hex 32)
KEY_BOB=$(openssl rand -hex 32)

bunx wrangler secret put TICK_API_KEYS
# Paste, comma-separated `<key>:<agent-identifier>`:
#   k_alice_${KEY_ALICE}:frames-runtime:0xAliceWalletOrSlug,k_bob_${KEY_BOB}:frames-runtime:0xBobWalletOrSlug

# Share each <key> with the matching customer. They send it as:
#   Authorization: Bearer <key>          (canonical)
#   X-Tick-API-Key: <key>                (fallback for harnesses that swallow Auth)
```

A Bearer header that doesn't match a configured key **401s immediately** — does
not fall through to IP-hash auth.

#### TICK_ALLOWED_AGENTS

Per-agent allowlist (the identity comes from TICK_API_KEYS lookup, x402
verify, or IP-hash). Use this to opt in specific identifiers.

```bash
# (a) Closed alpha — list each customer's mapped agent identifier verbatim:
bunx wrangler secret put TICK_ALLOWED_AGENTS
# → frames-runtime:0xAliceWalletOrSlug,frames-runtime:0xBobWalletOrSlug

# (b) Open beta — `*` opens the gate to anyone whose Bearer is valid.
#     Only safe once Phase B x402 billing is wired.
bunx wrangler secret put TICK_ALLOWED_AGENTS
# → *
```

Allowlist syntax (`src/allowlist.ts`):
- Exact match — `frames-runtime:0xabc`
- Prefix glob — `ip:7f1a*` matches any IP hash starting with `7f1a`
- `*` anywhere — opens the gate

### 1e. (Skipped in Phase A) Facilitator

`apps/tick-facilitator/` is **NOT deployed** in this phase. The hosted
endpoint accepts unauthenticated requests gated only by the allowlist;
payment collection is Phase B.

Leave `FACILITATOR_URL` unset in `apps/tick/wrangler.toml`. `attemptSettle`
will no-op and `verifyInboundX402` will run in optional mode.

---

## 2. Deploy `tick` (the runtime)

```bash
cd apps/tick

# Outbound wallets — only if curate/discover will make paid tool calls.
# Skip for verify/refresh-only alpha.
bunx wrangler secret put SOLANA_OUTBOUND_KEYPAIR_JSON     # 64-byte JSON array
bunx wrangler secret put EVM_OUTBOUND_PRIVATE_KEY         # 0x-hex
bunx wrangler secret put SOLANA_RPC_URL                   # mainnet RPC

# LLM provider — BYOK preferred (gateway holds keys, Stripe-style):
bunx wrangler secret put AI_GATEWAY_URL                   # https://gateway.ai.cloudflare.com/v1/<acct>/<gw>
bunx wrangler secret put AI_GATEWAY_BYOK_ALIAS            # alias name from gateway UI
bunx wrangler secret put AI_GATEWAY_TOKEN                 # (optional) gateway auth bearer

# Passthrough fallback (dev / no gateway):
bunx wrangler secret put ANTHROPIC_API_KEY                # sk-ant-…

bunx wrangler deploy
```

Verify health:

```bash
curl https://tick.<your-subdomain>.workers.dev/health
```

The `/health` response in v1 hosted mode looks like:

```json
{
  "ok": true,
  "ts": "2026-05-12T…",
  "db": true,
  "wallets": { "solana_configured": true, "evm_configured": true },
  "payments": {
    "facilitator_configured": false,    ← intentional in Phase A
    "audit_key_configured": true
  },
  "llm": { "ai_gateway_configured": true, "anthropic_passthrough_configured": false },
  "hosted": {
    "allowlist_entries": 3,
    "allowlist_open": false,            ← `*` would flip this to true
    "closed_by_default": false          ← true means you forgot the allowlist
  }
}
```

**`closed_by_default: true` is the smoke check you missed step 1d.** Fix it
before any customer hits `/run`.

---

## 4. Smoke test against a real public frame

```bash
RUN=$(curl -sS -XPOST https://tick.<your-subdomain>.workers.dev/run \
  -H content-type:application/json \
  -d '{
        "op": "verify",
        "frame": "https://github.com/microchipgnu/ai-agent-wallets-eu",
        "budget": "0.10"
      }')
echo "$RUN" | jq .summary
echo "$RUN" | jq -r .run_id
```

Then pull the persisted receipt:

```bash
ID=$(echo "$RUN" | jq -r .run_id)
curl -sS https://tick.<your-subdomain>.workers.dev/runs/$ID | jq .
```

Expected: a populated `tool_log` and `events` array, `status: "completed"`.

---

## 4b. Publish the CLI to npm

The local CLI ships independently of the hosted endpoint — customers who
prefer to bring their own wallet skip the hosted call entirely.

```bash
cd apps/tick

# 1. Flip the package public — currently private to prevent accidental publish
#    while in development. Edit package.json:
#       "private": false       (was: true)

# 2. Verify the build is fresh
bun run typecheck && bun test && bun run build

# 3. Publish
npm publish --access public
```

After this, `npx -y @frames-ag/tick verify <frame>` works globally. The MCP
server is the same package: `npx -y @frames-ag/tick mcp`.

---

## 5. Day-2 operations

| Action                           | Command / endpoint                                                            |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Cancel an in-flight run          | `DELETE /runs/:id` (best-effort; full cancellation needs DO-based RunSession) |
| Replay a request                 | Send the same body with `Idempotency-Key: <uuid>` header                      |
| Purge a wallet's history (GDPR)  | `DELETE /history?address=<wallet>` (SIWX gating ships post-alpha)             |
| Inspect a single run             | `GET /runs/:id`                                                               |
| List a wallet's runs             | `GET /history?address=<wallet>`                                               |
| Wallet config probe              | `GET /health`                                                                 |
| Rate-limit policy                | Per-wallet (or per-IP pre-SIWX) sliding window in `src/rate-limit.ts`         |

Tail logs:

```bash
bunx wrangler tail tick
```

D1 ad-hoc queries:

```bash
bunx wrangler d1 execute tick-receipts --remote --command "SELECT op, status, settled, started_at FROM runs ORDER BY started_at DESC LIMIT 20"
```

---

## 6. Rollback

```bash
# Both apps are versioned by wrangler — list versions and roll back if needed.
bunx wrangler deployments list
bunx wrangler rollback <version-id>
```

D1 migrations are forward-only. If a migration breaks production, write a new
remediation migration; don't `DROP` columns in a live receipt store.

---

## 7. Failure modes worth knowing

- **Closed by default** — fresh deploys with no `TICK_ALLOWED_AGENTS` 403 every
  `/run` call. `/health.hosted.closed_by_default: true` is the canary.
- **D1 batch write fails** — `persistFinalize` falls back to sequential
  inserts and logs `persistFinalize_failed` + `persistFinalize_fallback_failed`.
  The customer still gets their `/run` response; the receipt is just
  best-effort persisted.
- **AI Gateway alias missing** — `curate` / `discover` 400 with
  `missing_llm_auth`. `verify` / `refresh` don't need an LLM and stay green.
- **Wallet keys malformed** — `bootWallets` throws, `pickRefetcher` falls back
  to the free HTTP refetcher (read-only paths still work).

---

## Phase B — when to add a facilitator

You're in Phase A as long as the allowlist gates abuse + no one's asked for
on-chain settlement. Add a facilitator when one of these is true:

1. **You want to charge customers per call.** Allowlist is a closed-beta tool;
   it doesn't scale to public access. Point `FACILITATOR_URL` at Coinbase CDP
   (`https://api.cdp.coinbase.com/x402`) and require payment headers.
2. **A customer wants Solana, Tempo, or MPP** — CDP is Base-only. Deploy
   `apps/tick-facilitator/` on CF Containers and point at it.
3. **Multi-chain settlement** — same answer; self-host Faremeter.

### Phase B with Coinbase CDP — x402 v2 native (v0.0.3+)

As of v0.0.3, the runtime speaks canonical [x402 v2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) natively. CDP integration is a few secrets, not an adapter rewrite.

```bash
cd apps/tick

# Point at CDP's facilitator. Confirm the current base URL in their docs:
#   https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/x402-facilitator
bunx wrangler secret put FACILITATOR_URL          # e.g. https://api.cdp.coinbase.com/v2/x402

# PaymentRequirements config — what the server quotes in 402 challenges:
bunx wrangler secret put TICK_PAY_TO_ADDRESS      # operator wallet (EVM hex or Solana base58)
bunx wrangler secret put TICK_PAY_NETWORK         # base | solana-mainnet | tempo (default: base)
bunx wrangler secret put TICK_PAY_ASSET           # token contract; default: USDC on Base
# Optional:
bunx wrangler secret put TICK_PAY_SCHEME          # erc3009 / spl-token (default: inferred from network)
bunx wrangler secret put TICK_PAY_MAX_TIMEOUT_SECONDS  # default 90

# Flip allowlist to open mode if you want public access:
bunx wrangler secret put TICK_ALLOWED_AGENTS      # → `*`

bunx wrangler deploy
```

After this:
- `verifyInboundX402` becomes strict (FACILITATOR_URL + TICK_PAY_TO_ADDRESS together)
- Missing payment header on `/run` → 402 with the `paymentRequirements` body
- Client signs and retries with `PAYMENT-SIGNATURE: <base64 PaymentPayload>` header
- `attemptSettle` runs after every successful op and stamps the on-chain tx hash on the run row
- `/health.payments.facilitator_configured` flips to `true`

**CDP API auth**: if CDP requires a per-call auth header (API key / project ID), pass it via the `facilitatorAuthHeader` param when calling `verifyInboundX402` / `settleX402`. Check current CDP docs for exact header names. Today's app-level wiring doesn't forward this header automatically — that's a one-line addition in `app.ts` (`{ facilitatorAuthHeader: { "x-cdp-api-key": env.CDP_API_KEY } }`).

### Phase B with self-hosted Faremeter

Use the **original** "Deploy `tick-facilitator`" sequence — left intact in the
repo at `apps/tick-facilitator/`. You'll need to provision a Solana admin
keypair + an EIP-3009 EVM key + RPC URLs for each chain. Point `FACILITATOR_URL`
at the self-hosted facilitator instead of CDP. The rest of the runtime
behavior is identical.
