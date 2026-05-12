# @frames-ag/tick

## 0.0.12 — 2026-05-12 (privacy gates + iteration_log + budget pre-flight)

Three improvements from the post-launch review:

### Privacy gates on read endpoints
- **`GET /runs/:id`** now requires the caller's `Authorization: Bearer
  <key>` (via `TICK_API_KEYS`) to map to the same agent that created the
  run. Earlier "public by run_id possession" leaked frame URL, agent
  identity, source URLs, and the agent's narrative reasoning. 403 on
  mismatch.
- **`GET /history?address=`** same: caller agent must match the queried
  address.
- **`DELETE /history?address=`** adds bearer-token path alongside the
  existing x402-verify path. Either works (whichever is configured), and
  both require identity match.
- New helper `resolveCallerAgent(c)` centralizes the bearer lookup for
  read endpoints. Dev mode (no `TICK_API_KEYS` configured) bypasses the
  gate, consistent with closed-by-default on `/run`.

### `iteration_log` in `RunResult`
Top-level `result.iteration_log: IterationLogEntry[]` exposes one entry
per LLM call across the agent loop:
```ts
{ iter, model, input_tokens, output_tokens, cost, stop_reason }
```
Customers can see exactly where their budget went — which iter, which
model served the call (anthropic vs @cf), and what stopped each call.
Curate and discover both populate it. `LlmResponse.model` is now part of
the LlmClient surface; `IterationLogEntry` is exported from
`@frames-ag/tick-types@0.0.2`.

### Budget pre-flight check
When a caller passes an explicit `budget` to curate/discover that's
less than 50% of the calibrated default, `/run` returns 400 with a
`recommended_budget` hint instead of dispatching. Prevents the
"0 events" failure mode we hit live with a $0.50 curate that burned
$1.40 of Claude tokens.

@frames-ag/tick-types bumped to v0.0.2.

## 0.0.11 — 2026-05-12 (retry transient upstream errors)

Wraps `callAnthropic` in the existing `retry` helper. Real run hit
"Anthropic 529 (via AI Gateway): Overloaded" — upstream transient.
3 retries, 1s initial delay, exponential backoff. Default predicate
catches status >= 500 + network errors; 4xx fails-fast.

## 0.0.10 — 2026-05-12 (budget guard + narrative surfacing)

Three small changes from real-run learnings. Live `curate` against
`ai-agent-wallets-eu` (Claude Sonnet 4.6 via CF marketplace) blew $1.40
of LLM tokens against the prior $1.50 default ceiling and produced 0
events because the safety_floor guard only tracked tool spend.

### Default budgets bumped (`packages/tick-types`)
- `curate`:   $1.50 → **$3.00**
- `discover`: $0.50 → **$1.50**
- `refresh`:  $0.30 → **$0.50**
- `verify`:   $0.15 (unchanged — no LLM)

Flagship LLM tokens dominate the budget; the old numbers were
calibrated for cheaper models + tool-spend-only guards.

### LLM-cost-aware budget guard (`curate.ts` + `discover.ts`)
- Track `maxLlmCostSeen` across iterations.
- Before each new iter, project next LLM call as `1.2 × maxLlmCostSeen`.
- Halt early when `remaining < projected + safety_floor`.

Previously the agent could run a full iteration into a budget shortfall,
post-hoc detect it, then spend ANOTHER call asking for a wrap-up —
overrunning by 2×. The new projection halts BEFORE the overrun.

### `RunResult.narrative` (top-level)
The model's one-paragraph wrap-up (previously buried in
`report.llm_summary`) now also lives at `result.narrative`. It's the
single most human-readable output of any run and customers shouldn't
have to dig for it.

Example from a real run:
> *"This curate tick read the full current state of the
> ai_agent_wallets_eu dataset (13 entities) and performed live
> verification... Budget constraints prevented completing set_facts
> writes for Ovra's founded_year (2025, confirmed from structured
> data) and last_news_url/last_news_date updates for Wirex and other
> entities... Recommended follow-up actions for the next tick:..."*

That narrative is high-quality customer-facing output; promoting it
surfaces it in the response shape directly.

@frames-ag/tick-types bumped to v0.0.1 (RunResult.narrative addition).

## 0.0.9 — 2026-05-12 (live end-to-end via CF marketplace + cleanup)

First fully-live `curate` run against Claude Sonnet 4.6 via Cloudflare
marketplace billing — no Anthropic account, CF pays Anthropic from the
gateway's prepaid balance.

### Required gateway path: native Anthropic Messages API
Both `env.AI.run("anthropic/...")` AND `/compat/chat/completions` have
server-side bugs translating tool_use blocks for Anthropic models —
they strip or mis-map `tool_use.id` on the way to Anthropic's parser.
**The native `/anthropic/v1/messages` path works correctly** with marketplace
billing when called with `Authorization: Bearer <gateway-token>` (no
`x-api-key`, no BYOK alias).

### `callAnthropic` auth ladder (v0.0.9)
1. `byokAlias` set       → `cf-aig-byok-alias` header (gateway holds key)
2. `anthropicApiKey` set → `x-api-key` header (passthrough; your Anthropic bills)
3. `gatewayToken` only   → `Authorization: Bearer` (**marketplace; CF bills**)
4. else                  → error

The third case is the v1 happy path: set `AI_GATEWAY_URL` +
`AI_GATEWAY_TOKEN` + fund the gateway in the dashboard. Tick handles
the rest.

### Removed
- `callGatewayCompat` (broken for Anthropic — never landed as a customer path)
- The Anthropic branch of `callAiBinding` (same bug as compat)
- Debug logging from the binding path

### Live validation
```
curate · ai_agent_wallets_eu@e4f9cef · 5 iter · 1 events · 8 tool calls
```
End-to-end through tick.microchipgnu.workers.dev with bearer-token auth,
allowlist gate, service binding to frames-cloud, and Anthropic via
marketplace.

## 0.0.8 — 2026-05-12 (AI binding — CF bills for Anthropic via marketplace)

Adds support for CF's **Workers AI binding marketplace routing**:
`env.AI.run("anthropic/claude-sonnet-4-6", ...)` calls Anthropic's flagship
through Cloudflare's edge, with **Cloudflare billing you directly** — no
Anthropic account or API key needed.

This was the missing path: previous releases assumed Anthropic models
always required an external Anthropic account (BYOK or passthrough). CF's
marketplace handles billing for partnered third-party providers (Anthropic,
OpenAI, Google, etc.) when called through `env.AI.run`.

### Config
```toml
# wrangler.toml
[ai]
binding = "AI"
```

```bash
# Optional: route AI binding calls through your gateway for logging.
wrangler secret put AI_GATEWAY_SLUG    # → e.g. "frames-ai-gateway"
```

When the binding is present, `LlmClient` automatically routes
`anthropic/*` and `@cf/*` models through `env.AI.run()` — preferred over
HTTP paths because it stays inside CF's edge with no extra hop.

### Implementation
- `LlmClient.callAiBinding()` handles both shapes:
  - `anthropic/*` → Anthropic Messages API body, native response shape
  - `@cf/*` → OpenAI-compat body, translated back to Anthropic-shape via the existing helpers
- Optional `{ gateway: { id } }` routing for the gateway logging dashboard
- `/health.llm.ai_binding_present` + `ai_binding_gateway_slug` surface state

### Priority order in `LlmClient.call()`
1. **AI binding** (env.AI) — for `@cf/*` AND `anthropic/*` models. CF billing.
2. **Workers AI HTTP** — for `@cf/*` when no binding (e.g. Bun dev). CF billing.
3. **AI Gateway BYOK** — for `anthropic/*` when binding absent. Anthropic billing via your stored key.
4. **Direct Anthropic** — for `anthropic/*` with `ANTHROPIC_API_KEY` set. Anthropic billing.

The right default for v1 hosted is path 1 — flagship quality, CF billing,
no operator-side Anthropic account to manage.

110 tests still passing.

## 0.0.7 — 2026-05-12 (Workers AI mode — CF-hosted models, CF-billed)

Adds a third LLM auth path: **Workers AI**. Routes `@cf/*` models to
Cloudflare's hosted catalog (Llama 3.3 70B, Qwen QwQ-32B, Gemma, etc.).
Cloudflare bills you directly per-token — no Anthropic / OpenAI / Google
account required.

### Why
Customers who want to skip the provider-account dance can pay CF for
tokens. Tradeoff: Workers AI's catalog is open-weight only (no Claude /
GPT-4 / Gemini Pro). For agent loops with tool use, `llama-3.3-70b-
instruct-fp8-fast` is the recommended default — decent at function
calling, fast inference, low cost (~$0.29 / $2.25 per 1M tokens).

### Config (per `apps/tick/DEPLOY.md`)
```bash
wrangler secret put CF_ACCOUNT_ID         # 97c691...
wrangler secret put WORKERS_AI_TOKEN      # CF API token w/ Workers AI:Run scope
wrangler secret put WORKERS_AI_MODEL      # @cf/meta/llama-3.3-70b-instruct-fp8-fast
```

When all three are set, `LlmClient.call()` prefers Workers AI over the
Anthropic / BYOK paths regardless of per-agent model defaults.

### Implementation
- `LlmClient.callWorkersAi()` — POSTs to `api.cloudflare.com/.../ai/v1/chat/completions` (OpenAI-compat shape).
- **Shape translators** (`anthropicToOpenAiMessages`, `openAiFinishToAnthropicStop`) — translate Anthropic-style messages + tool_use blocks ↔ OpenAI-style messages + tool_calls. The ops (curate/discover) keep returning Anthropic-shape `LlmResponse` so they don't need to change.
- Per-token pricing for the common `@cf/*` models added to the `PRICES` table.
- `/health.llm.workers_ai_configured` surfaces config state.
- `missing_llm_auth` error message updated to include the new path.

110 tests still passing — the Workers AI path doesn't affect any existing test (Anthropic-shape goes through the same code paths it always did).

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
