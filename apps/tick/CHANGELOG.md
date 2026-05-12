# @frames-ag/tick

## 0.0.6 — 2026-05-12 (fix: rewrite workspace:* deps for npm install)

v0.0.5 published cleanly to npm but with `workspace:*` left in the
`dependencies` field for `@frames-ag/payment-tempo` and
`@frames-ag/tick-types`. `npm install`/`npx` can't resolve that protocol
(it's a bun/pnpm-only specifier), so `npx -y @frames-ag/tick@0.0.5` fails
with `EUNSUPPORTEDPROTOCOL`. `bun publish` (which the CI Release workflow
ended up using through `bunx changeset publish`) doesn't rewrite workspace
specifiers the way `npm publish` does.

Fix: replace `workspace:*` with the actual semver in tick's package.json.
Bun's local install still resolves the workspace members by name + version,
so `bun install` at the monorepo root is unaffected.

No code changes; just the install path for downstream consumers.

## 0.0.5 — 2026-05-12 (customer prompt auto-discovery)

Closes the `frames-examples` migration gap: customers keep their existing
`<dataset>/prompt.md` files in place. The CLI auto-discovers them from the
frame URL's path component (relative to cwd) and POSTs the contents as
`params.customer_prompt`. No migration script, no README-section convention
imposed.

### What changed
- **`src/cli.ts`** — `resolveCustomerPrompt()`: auto-discovers `prompt.md` from the path component of the frame URL (`https://github.com/<user>/<repo>/datasets/foo` → `./datasets/foo/prompt.md`). Falls back to `./prompt.md` for whole-repo frames. Flags: `--prompt-file <path>` (explicit override, errors if missing) and `--no-prompt` (skip discovery). Logs the resolved path to stderr so CI runs show which prompt was picked up.
- **`/run` handler** — extracts `body.params.customer_prompt`, validates it's a string, hard-caps at 32 KiB (DoS guard), forwards to `curate()` / `discover()` via `sharedLlmOpts.custom_prompt`. Logs `customer_prompt_attached` with byte count.
- **`CurateOptions.custom_prompt`** + **`DiscoverOptions.custom_prompt`** — both now formally declare the option (`buildCurateSystem` already consumed it; the field just wasn't wired in).
- **`buildDiscoverSystem`** — appends the customer prompt under a "Customer instructions (from prompt.md)" header, matching curate's pattern.
- **6 new tests** across `test/prompt-discovery.test.ts` (path inference) and `test/curate.test.ts` (system prompt contains the custom prompt verbatim). 110/110 green.

### Auth ladder summary (after v0.0.4 + v0.0.5)
1. `TICK_API_KEYS` Bearer token (v0.0.4) → stable customer identity
2. x402-verified payer (v0.0.3) → wallet identity when facilitator configured
3. IP-hashed fallback → dev/smoketest

### Migration for `frames-examples`
Per the updated `MIGRATION.md`: workflow-file change only. No `prompt.md` files need to move. The CLI picks them up automatically when invoked from the repo root. See `drafts/frames-examples-migration-pr.md` for the ready-to-push PR.

## 0.0.4 — 2026-05-12 (bearer-token mode for closed alpha)

Adds `TICK_API_KEYS` — a comma-separated list of `<key>:<agent-identifier>` pairs that maps Bearer tokens to stable agent identities. Lets closed-alpha customers authenticate before Phase B x402 billing ships, without depending on the brittle IP-hash fallback (GitHub Actions runners rotate IPs).

### Auth ladder, weakest first

1. **`TICK_API_KEYS` Bearer token** (v0.0.4) — stable customer identity via `Authorization: Bearer <key>` or `X-Tick-API-Key: <key>`. Server maps the key to a configured agent identifier (e.g. `frames-runtime:0xCustomerA`).
2. **x402 verified payer** (v0.0.3) — when the facilitator is configured, the verified wallet becomes the agent automatically. No shared secrets.
3. **IP-hashed fallback** — for unauthenticated dev / smoketest traffic.

A Bearer token that doesn't match a configured key returns **401 immediately** (does NOT fall through). Prevents an attacker from sending a junk key and silently getting IP-hash auth.

### What changed
- **`src/api-key.ts`** (new) — `parseApiKeys()`, `extractBearerToken()`, `lookupApiKey()`. Accepts both `Authorization: Bearer <key>` and `X-Tick-API-Key: <key>`. Constant-time comparison resists naive timing attacks.
- **`/run` handler** — bearer-token lookup happens before x402 verify; matched key → use mapped agent, no-header → fall through to x402/IP, bad header → 401 `invalid_api_key`.
- **`/health.hosted.api_key_count`** surfaces how many keys are configured (smoke check: is auth set up?).
- **20 new tests** (`test/api-key.test.ts`) — parsing (empty, malformed, colon-in-agent), header extraction (Authorization + X-Tick-API-Key + precedence), lookup (matched / unmatched / no-config-but-header-sent / constant-time). 104/104 green overall.

## 0.0.3 — 2026-05-12 (x402 v2 native + Phase B unblocked)

Rewrote inbound payment verify + settle to be **canonical x402 v2 native**
instead of the prior Faremeter-style custom shape. CDP and upstream Faremeter
(v0.21.0+, which negotiates to v2) now both work as facilitators with **no
adapter layer** — same client code, configurable endpoint.

### What changed
- **`src/payment/types.ts`** (new) — full TypeScript types for `PaymentRequirements`, `PaymentPayload`, `PaymentRequiredResponse`, `FacilitatorVerifyResponse`, `FacilitatorSettleResponse`. Field names match the [x402 v2 spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) exactly.
- **`src/payment/payment-requirements.ts`** (new) — `buildPaymentRequirements(env, op, budget)` constructs the spec-shaped `PaymentRequirements` from operator env (`TICK_PAY_TO_ADDRESS`, `TICK_PAY_NETWORK`, `TICK_PAY_ASSET`, `TICK_PAY_SCHEME`, `TICK_PAY_MAX_TIMEOUT_SECONDS`). Scheme defaults: `erc3009` on EVM-shaped networks, `spl-token` on Solana. Asset defaults to USDC on Base mainnet. `usdcToSmallestUnit()` helper converts decimal to 6-decimal integer string.
- **`src/payment/x402.ts`** rewritten:
  - Reads `PAYMENT-SIGNATURE` header (base64-encoded `PaymentPayload`)
  - POST `{ x402Version: 2, paymentPayload, paymentRequirements }` to facilitator `/verify` and `/settle`
  - Parses canonical responses (`isValid` / `invalidReason` / `payer` on verify; `success` / `errorReason` / `transaction` / `network` / `amount` on settle)
  - Trailing-slash normalization on facilitator URL
  - Optional `facilitatorAuthHeader` param for CDP API-key injection
  - `decodePaymentPayload()` exported for tests / external use; handles both standard base64 and base64url
- **`/run` handler** now emits **402 challenges** with `{ x402Version: 2, error, resource, accepts: [paymentRequirements] }` body when strict mode (FACILITATOR_URL + TICK_PAY_TO_ADDRESS set) sees a request without the header. Clients sign and retry with the header, exactly per spec.
- **`attemptSettle`** now passes the verified `paymentPayload` + `paymentRequirements` through to `settleX402` instead of synthesizing fields. Stamps the real `transaction` hash from the facilitator onto the run row.
- **`DELETE /history`** identity-gate uses a zero-amount `PaymentRequirements` as the proof-of-identity vehicle.
- **27 new x402 tests** (`test/x402.test.ts`) — `usdcToSmallestUnit`, `buildPaymentRequirements`, `decodePaymentPayload` (round-trip + malformed + missing fields), and the full verify/settle wire shapes (mocked global fetch). Asserts that the request body is spec-shaped (`x402Version` + `paymentPayload` + `paymentRequirements`) and explicitly NOT custom-shaped. 84/84 green overall.

### Phase B is now genuinely unblocked

Coinbase CDP integration drops to a few env vars instead of an adapter rewrite:

```bash
wrangler secret put FACILITATOR_URL          # https://api.cdp.coinbase.com/v2/x402
wrangler secret put TICK_PAY_TO_ADDRESS      # operator wallet
wrangler secret put TICK_PAY_NETWORK         # base (or solana-mainnet, etc.)
# Plus CDP API auth headers if/when CDP needs them — passed via the
# facilitatorAuthHeader param when calling verify/settle.
```

The 2026-05-12 finding that "CDP isn't drop-in" is now obsolete — it was true against our pre-rewrite custom-shape client; the rewrite removed that gap.

### Migration note for existing callers

If any code outside this repo calls `verifyInboundX402` or `settleX402` directly,
**signatures changed**:
- `verifyInboundX402(req, facilitatorUrl, body, opts)` → `verifyInboundX402(req, facilitatorUrl, paymentRequirements, opts)`
- `settleX402(req, facilitatorUrl, amount, payer, network)` → `settleX402(facilitatorUrl, paymentPayload, paymentRequirements, opts)`

Response field renames: `valid` → `isValid` (internal), `tx_hash` → `transaction`.

## 0.0.2 — 2026-05-12 (v1 hosted gating + npm pre-publish)

Closes the "hosted v1 = no facilitator" path. The hosted `/run` endpoint
now ships with a deterministic agent allowlist (`TICK_ALLOWED_AGENTS`)
that's **closed by default**. Fresh deploys 403 every call until an
operator explicitly opts in callers, preventing accidental open-endpoint
abuse before x402 billing is wired.

Plus full npm publish prereqs: MIT LICENSE at monorepo root + apps/tick,
license / repo / homepage / bugs / keywords / engines metadata in
package.json, trimmed npm tarball (341.6 kB → 119.8 kB packed, 1.7 MB →
564.4 kB unpacked) by dropping internal PLAN.md and the dist/cli.js source
map from the published files.

### Hosted gating
- **`src/allowlist.ts`** — `parseAllowlist` + `checkAllowlist` with exact-match, prefix-glob (`ip:7f1a*`), and `*` open-gate sentinel
- **`/run` middleware** — 403 + `agent_not_allowlisted` for un-whitelisted callers (`src/app.ts`)
- **`/health.hosted`** — surfaces `allowlist_entries`, `allowlist_open`, `closed_by_default`. The third flag is the smoke-check operators use to confirm the gate is configured
- **14 new allowlist tests** (`test/allowlist.test.ts`) — undefined env, empty env, exact match, prefix glob, wildcard, case-sensitivity. 57/57 green overall
- **Smoke test extended** — fresh `POST /run closed` case verifies the closed-by-default 403 behavior end-to-end

### Documentation
- **`DEPLOY.md` rewritten** to lead with the v1 happy path: no facilitator, allowlist-gated, CLI publish included. The facilitator path is demoted to "Phase B — when to add" with both CDP and self-host options documented
- **CLI publish step** (`npm publish --access public`) added as an explicit deploy stage
- **`/health` example** updated with the v1 hosted-mode shape (`facilitator_configured: false` is intentional, not a missed config)
- **`STRATEGY.md`** at monorepo root — value-capture options + current hosted-tick bet + the catalog correction

## 0.0.1 — 2026-05-11 (pre-alpha, hardening pass)

Built on top of v0.0.0; closes 10 remaining audit gaps end-to-end.

### Inbound payments
- **x402 verify wired into `/run`** (`src/payment/x402.ts`). Auto-strict when `FACILITATOR_URL` is configured: payment headers are required, the facilitator is authoritative, 401 on rejection. Falls back to optional mode when `FACILITATOR_URL` is unset (dev). Verified payer replaces the IP-hashed identity for the rest of the run.
- **Settle wired** — `attemptSettle()` runs after every successful op, calls `settleX402` against the facilitator, and stamps the returned `tx_hash` onto the run row via `persistFinalize`. Skips silently when no facilitator, no verified payer, or zero-cost run. Settle failures log but never fail the op.
- **Receipt signing** (`src/payment/audit-signer.ts`) — ed25519 over canonical JSON of every `tool.invoked` receipt. Key bootstrapped from `AUDIT_PRIVATE_KEY` (32-byte hex/base64url seed, PKCS8-wrapped for WebCrypto). When unset, receipts ship unsigned and `/health` surfaces `audit_key_configured: false`. 8 unit tests cover canonical-JSON determinism, key loading, and the signature-field-exclusion invariant.
- **`DELETE /history` hardened** — when `FACILITATOR_URL` is set, requires a verified x402 payment header AND the payer must match `?address=`. Third parties can no longer purge another wallet's runs even with knowledge of the address.

### Runtime
- **SSE streaming on `/run` — now progressive**. Opt-in via `Accept: text/event-stream`. Emits `started` immediately, `frame_event` for each frame event the moment the op produces it (no buffering), `heartbeat` every 5s, terminal `completed` (full RunResult) or `error`. Plumbed via an `onEvent` callback threaded through all four ops (curate / discover / verify / refresh).
- **discover latent bug fixed**: previously discarded `tool.invoked` receipts (and `r.event` from paid web_fetches). Now collects them into `OpOutcome.events` so spend is auditable and citable from the `propose_entity` review queue.
- **Batched D1 writes** in `persistFinalize` — single `db.batch()` collapses N tool_calls + N events + 1 run update into one round-trip. Sequential-write fallback on batch failure so partial receipts still land.
- **GDPR right-to-erasure** — `DELETE /history?address=<wallet>` purges runs (cascading to tool_calls + events).
- **Idempotency-Key support** on `POST /run` — replays terminal results, 409s on in-flight matches.

### Library surface
- **`@frames-ag/tick` programmatic entry** — `src/lib.ts` re-exports the four ops, the FrameClient, the CatalogClient, the LlmClient, and the payment helpers. `package.json` ships `types: dist/types/lib.d.ts` so embedders get full TS surface.
- **Build** now emits both `dist/cli.js` (Node shebang) and `dist/types/` (declarations) via `tsconfig.build.json`.

### Tests + docs
- **5 new curate-loop tests** (`test/curate.test.ts`) — end_turn, max_iters, max_tokens, unrecognized stop_reason, budget exhaustion, plus an onEvent progressive-callback assertion.
- **8 new audit-signer tests** (`test/audit-signer.test.ts`) — canonical-JSON determinism, hex seed loading, no-key fallback, signature stability across key permutations, signature-field exclusion. 43/43 green overall.
- **Smoke test extended** (`scripts/smoketest.ts`) — now covers `/history` + `DELETE /history` gating and live-validates the SSE response actually emits `event: started` in the first chunk.
- **README refreshed** — full endpoint table including `DELETE /runs/:id`, `DELETE /history`, `Idempotency-Key` and `Accept: text/event-stream` headers, the SSE frame protocol, and the `AUDIT_PRIVATE_KEY` secret. Links to `DEPLOY.md` + `MIGRATION.md`.
- **`DEPLOY.md`** — operator runbook from clone to live (facilitator + runtime + day-2 ops + failure modes).
- **`MIGRATION.md`** — guide for `frames-examples` / `blindspot.news` to swap from `opencode run` → `npx -y @frames-ag/tick curate` (or the hosted `POST /run`).
- **PreMortem document marked HISTORICAL** with a status block tracking which 2026-05-11 risks have shipped mitigations.

## 0.0.0 — 2026-05-11 (pre-alpha)

Initial development. All code shipped in a single intensive session; not yet on npm.

### Operations

- **`verify`** — read-only re-fetch of every fact's source URL. Classifies drift across five kinds: `source_dead` / `value_drift` / `excerpt_missing` / `source_redirect` / `verified`. No frame mutations.
- **`refresh`** — verify iteration + emits real frame events: `fact.deprecated` for dead/drifted sources, `evidence.attached` for redirects. Falls back to `report.skipped_for_missing_fact_id` when frames-cloud doesn't surface fact_ids.
- **`curate`** — full agent loop with 9 tools: `query` + 4 frame writes (`add_entity_with_facts`, `set_facts`, `deprecate_fact`, `attach_evidence`) + 3 catalog tools (`catalog_search`, `catalog_get`, `tool_invoke`) + `web_fetch` fallback. LLM-driven; budget enforced per-turn.
- **`discover`** — search-only candidate proposer. Same agent-loop shape as curate but mutation tools replaced with `propose_entity`; candidates land in `report.candidates[]` for human review queue rather than the frame.

### Architecture

- **Cloudflare Workers** runtime, Hono entrypoint, extends the `agents` SDK base
- **D1 persistence** — `runs` / `tool_calls` / `events` tables (3 + 8 indexes) keyed by `run_id`, fail-open writes, cascade-delete
- **Cloudflare AI Gateway (BYOK)** for LLM routing — gateway holds provider keys; tick references them by alias. Passthrough fallback for dev. Model strings prefixed `<provider>/<model-id>`.
- **`@faremeter/fetch wrap()`** for outbound paid HTTP — auto-negotiates x402 v1/v2 and MPP across Solana + Base + Tempo. Single fetch wrapper handles all three protocols transparently.
- **`@frames-ag/payment-tempo`** (in monorepo) plugs MPP-on-Tempo into the wallet stack — no Stripe dependency in tick's critical path.
- **Self-custody wallets** — env-loaded keys (`SOLANA_OUTBOUND_KEYPAIR_JSON`, `EVM_OUTBOUND_PRIVATE_KEY`). EVM key serves both Base x402 and Tempo MPP.
- **Catalog-mediated discovery** via [catalog.frames.ag](https://catalog.frames.ag) (5,797 ToolDescriptors). Pre-checks `payment.price_hint` against remaining budget before signing. Server-side filter on `quality.l30DaysTotalCalls > 0` (spam prevention).
- **Per-IP rate limits** — sliding-window check via D1 (60s + 3600s). Identity flips to wallet address when SIWX signature verification lands.

### Endpoints

- `POST /run` — dispatch the four ops; supports `verify` / `refresh` / `curate` / `discover`
- `GET /runs/:id` — full receipt (run + events with parsed payloads + tool_log)
- `GET /history?address=<wallet>` — list runs by agent
- `GET /balance` — wallet config summary
- `GET /health` — `{ ok, ts, db, wallets: { solana, evm } }`

### Distribution

- **MCP server** — `bun src/cli.ts mcp` runs the stdio MCP server exposing `runtime.curate / refresh / verify / discover` as tools for any MCP-aware harness (opencode, Claude Code, Codex CLI, Cursor)
- **Compiled CLI** — `bun run build` produces `dist/cli.js` (482 KB) with Node-compatible shebang; ready for `npx -y @frames-ag/tick` post-publish
- **SKILL package** — `apps/tick/skill/{SKILL.md, skill.json}` matching `frames-engineering/skills` format

### Testing

- **23 unit tests** across `test/{rate-limit, frame-client, verify}.test.ts` (Bun test, ~15ms)
- **Smoke** (`bun run smoke`) exercises `GET /`, `GET /health`, `POST /run verify` (gracefully skips when frames-cloud isn't reachable), bad-op rejection
- **Live-validated** against `microchipgnu/ai-agent-wallets-eu`: 13 entities, 65 fields checked, 36 verified, 29 drifts via local frames-cloud

### Frame protocol contribution

- Contributed `run_id` envelope field + `facts.set_many` event type upstream to `packages/frame` (v0.2.0). PROTOCOL.md + types.ts + projector.ts + CHANGELOG.md updated; typecheck clean.

### Open / external-auth blocked

- Real SIWX signature verification (replaces IP-hashed identity; verify now overrides agent when the facilitator returns a payer). Production settle is wired and fires after every successful run when the facilitator is deployed.
- Tempo MPP end-to-end against a real seller (requires funded Tempo wallet)
- Sub-agent routing via `@cloudflare/think` facets (currently `agent: title|build|explore` only picks model)
- Workers-native Faremeter facilitator fork (currently CF Containers via Path 1)

See [PLAN.md §9](./PLAN.md#9-build-plan--status-as-of-2026-05-11) for full status.
