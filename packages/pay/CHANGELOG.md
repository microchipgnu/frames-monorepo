# @frames-ag/pay

## 0.5.1

### Patch Changes

- a129fd3: Send agentwallet's `preferredChain`/`preferredToken` hints instead of the ignored `payment_rail` field on delegated dispatch.

  agentwallet's `/actions/x402/fetch` honors `preferredChain` (`'evm' | 'solana' | 'auto'`) and `preferredToken`; it never read `payment_rail`, so the rail the dispatcher selected was silently dropped and agentwallet fell back to its `auto` default (which can route a Base/USDC selection onto an MPP/Tempo challenge). The dispatcher now translates the descriptor's `payment.network` into agentwallet's enum (`base`/`eip155:*` → `evm`, `solana*` → `solana`) and forwards `payment.currency` as `preferredToken`, so the chosen chain is the one that settles. Also maps `eip155:4217|42431` → `tempo` in `mapChainToNetwork` for correct receipt labeling.

## 0.5.0

### Minor Changes

- 07db601: fix(pay): preserve full upstream response body on DispatchError; classify aggregated rail failures

  Two related fixes motivated by the 2026-05-26 layoffs-2026 discover run where `pay_tool` returned the new aggregated `"no rail succeeded across 5 payment options"` error but the actual reason agentwallet rejected sat just past the **200-char truncation cliff** in the per-rail error messages.

  **1. `DispatchError` now carries the full upstream body.** When dispatch fails at the seller / agentwallet boundary, the thrown `DispatchError` attaches `{ parsed, raw, status, source }` on a new `body` property. `body.parsed` is the parsed JSON (or `null`), `body.raw` is the full untruncated text, `body.source` is one of `"seller" | "agentwallet" | "agentwallet_inner"` so callers know which layer failed. The message string is now truncated at **1000 chars** (was 200) for log-friendliness; full body is always available via `error.body` and via the typed error's `details.body`.

  **2. `classifyPayError` recognizes the new `"no rail succeeded"` prefix.** Before this PR the prefix added by PR #17 fell through to `kind: "unknown"`, so programs couldn't distinguish "agentwallet outage" from "real wallet issue." Now:

  - Parses every per-rail `agentwallet <status>:` from the runtime-failures tail
  - If all rails returned the same status → `details.uniform_status: <status>`
  - Always includes `rail_count` and `rail_statuses[]`
  - Classifies as `kind: "agentwallet_unreachable"` with `retryable: true` for `429 / 500 / 502 / 503 / 504`

  `agentwallet_unreachable` is also now retryable on **429** (was only 5xx) — a 429 is a transient throttle, not a permanent failure.

  For single-rail errors (one `pay_tool` call without runtime fallback), `details.body` and `details.body_source` are populated from the new `DispatchError.body` so the full upstream reason is one level away from the agent — not buried in a truncated message string.

  New tests in `packages/pay/test/error-classification.test.ts` pin the aggregated 429/500 classification, the single-rail body-in-details behavior, and a regression test for the 2026-05-26 bug (an error where the real reason — `tx_error: "EIP-3009 signature verification failed: nonce already used"` — appeared past the old 200-char cliff).

## 0.4.0

### Minor Changes

- baaa177: feat(pay): runtime fallback across `payment.accepts[]` rails when a dispatch attempt fails

  Before: `selectPaymentOption` picked the first option whose bridge built cleanly and (under `"block"`) whose balance covered `price_hint`. If THAT option's dispatch then failed at runtime (agentwallet `500`, seller `5xx`, etc.), `payForTool` threw without trying the remaining `accepts[]` options. For agentwallet-delegated wallets specifically, this was painful because the balance check is bypassed for delegated bridges — so the dispatcher always selected the primary rail even when its wallet was empty, only to throw on the first call.

  After: `payForTool` loops over `[primary, ...accepts[]]`. For each option it calls a new per-option helper `selectForOption`, then runs the dispatch. A `DispatchError` or `InsufficientBalanceError` from dispatch means "try the next rail" — non-pay exceptions (TypeErrors, etc.) still bubble immediately. Only when every option is exhausted does `payForTool` throw, with an aggregated message listing both selection-time and runtime failures.

  Additionally, `dispatchViaAgentwallet` now sends a `payment_rail` hint in the request body so agentwallet can honor the dispatcher's per-option choice when its server supports rail preference. Older agentwallet versions ignore unknown body keys; newer versions can loop through rails per attempt as the dispatcher does.

  Verified 2026-05-25 against the layoffs-2026 discover run: `prose run discover` against the multi-rail exa descriptor was failing at the first agentwallet `500` even though four other rails were available in `accepts[]`. With this change the dispatcher walks all of them.

  Internal refactor: `selectPaymentOption` is replaced by `buildOptionList` + `selectForOption` + the per-option loop in `payForTool`. The dispatch-after-selection logic is extracted into `dispatchAfterSelection`. No external API change — `payForTool`'s signature and return shape are unchanged.

  New test: `packages/pay/test/multi-rail-fallback.test.ts` pins the aggregated-error shape (all attempted networks named, count agrees) and the single-rail regression case.

## 0.3.0

### Minor Changes

- 6ca4b05: feat(pay): typed errors, balance preflight, descriptor drift check

  Three changes to make the failure modes from `pay_tool` actionable, motivated by the layoffs-2026 OpenProse discover run on 2026-05-25 that consumed three paid attempts before surfacing that the base wallet was empty.

  **`wallet_status` reports balances.** The MCP tool and `pay wallet status` CLI now probe each configured wallet's balance in USDC (and CASH on Solana) by default. Programs can now fail-fast in preflight on `WalletNotReady` when a wallet exists but is unfunded, instead of running the full plan and hitting `agentwallet 500` mid-flight. Skip with `include_balances=false` (MCP) or `--no-balances` (CLI) for an offline-only summary.

  **`pay_tool` returns typed errors.** Failures now come back as structured `{ kind, message, retryable, details?, cause? }` instead of opaque strings. `kind` is one of `insufficient_funds | network_unconfigured | agentwallet_unreachable | seller_rejected | balance_check_failed | wallet_signing_error | descriptor_mismatch | unknown`. Programs can branch on `kind` to implement the OpenProse `WalletNotReady` / `BudgetExceeded` / `NoCatalogTool` invariants reliably. The classifier (`classifyPayError`) is exported from the package index so non-MCP consumers can use it too.

  **New `check_descriptor_drift` MCP tool.** Compares each locked tool's descriptor against the live catalog and reports per-field diffs (focused on `payment.*`, `invocation.*`, `capabilities` by default). Free; one HTTP GET per locked tool. Programs should call this in preflight before a paid run so callers can spot a seller that changed rails since the lock was written — without needing to spoof the lockfile to find out (which was the only way to diagnose it before this change).

## 0.2.3

### Patch Changes

- 172d7d8: fix(pay): agentwallet loader defaults `baseUrl` when missing from `~/.agentwallet/config.json`; detect surfaces the default instead of masking

  `pay wallet init --auto` could leave the pay config in a broken state when the user's `~/.agentwallet/config.json` was written by an older onboarding that did not include the `baseUrl` field. The detector silently labelled the wallet `agentwallet @ frames.ag` (using `cfg.baseUrl ?? "frames.ag"` for display only), so the user saw a successful detection — but the loader strictly required `baseUrl` from the file and threw at first use:

  ```
  pay: wallets.base (agentwallet): /Users/<user>/.agentwallet/config.json missing baseUrl
  ```

  Two changes close the gap:

  **`src/config.ts`** — `agentwallet` loader resolves `baseUrl` from, in order:

  1. `base_url` set in the pay config stanza (override; allows self-hosted agentwallet)
  2. `baseUrl` in `~/.agentwallet/config.json` (current onboarding writes this)
  3. `AGENTWALLET_BASE_URL` env var
  4. `https://frames.ag` (canonical hosted default — same string the detector already used for the display label)

  `apiToken` and `username` checks remain strict; there is no sensible default for those.

  **`src/cli/detect.ts`** — when `~/.agentwallet/config.json` lacks `baseUrl`, the detector now:

  - labels the wallet `agentwallet @ https://frames.ag (defaulted)` so the user sees that a default was applied
  - emits an explicit `base_url: https://frames.ag  # defaulted — <path> missing baseUrl` line in the generated yaml stanza
  - includes `base_url` in the structured `entries[].config` so `pay wallet init --auto` writes the override into the pay config

  No behavior change for users whose agentwallet config already includes `baseUrl`.

## 0.2.2

### Patch Changes

- b226d7e: fix: drop `.ts` extensions from `@frames-ag/pay/wallet` re-exports

  Pre-existing latent bug. `packages/pay/src/wallet/index.ts` re-exported from `./wallet-registry.ts` and `./paid-fetch.ts` with explicit `.ts` extensions. Worked at runtime (Bun resolves), but downstream consumers with `allowImportingTsExtensions: false` (which is the recommended setting when `noEmit: false`) failed during declaration emit:

  ```
  error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
  ```

  Triggered today when `@frames-ag/tick@0.5.x` extended its public surface (`CurateOptions.walletCapability`) so the declaration emit started traversing pay's wallet types. Drop the `.ts` extensions to match standard TS conventions and unblock consumers' declaration builds.

  No behavior change. Same module, same exports.

## 0.2.1 — 2026-05-14 (hotfix — pass Solana RPC URL to x402 exact handler)

`createPaidFetch` in v0.2.0 passed `solanaRpcUrl` to the MPP Solana
charge client but **dropped it for the x402 exact handler**. Faremeter's
`createPaymentHandler` accepts the RPC as an optional third arg; when
omitted, it falls back to Solana's public `mainnet-beta` RPC
(rate-limited, ~300-800ms latency).

Fix: pass `opts.solanaRpcUrl` as the third argument to
`createX402SolanaHandler`. One-line change.

Caught before any paid Solana x402 calls were made — today's tick
hosted runs only fetch `github.com` URLs (free). But would have
manifested as slow/failing payments the first time a paid Solana
endpoint was hit.

Pre-existing in `faremeter-bridge.ts` (the descriptor-driven path) —
NOT fixed here because that's a different mechanism (descriptor
doesn't carry RPC config; needs a separate addressing). Tracked as
a follow-up.

## 0.2.0 — 2026-05-14 (createPaidFetch + subpath exports)

### Minor Changes

**New API: `createPaidFetch(opts)` for un-descriptored 402 negotiation.**

Pay's existing `buildHandlers(descriptor, entry)` is descriptor-driven
— right for catalog tool invocations. Some consumers (notably tick's
`web_fetch` tool) need 402 negotiation on arbitrary URLs without a
descriptor. For those, `createPaidFetch` takes a `WalletRegistry` and
returns a paidFetch wired up with default-mode handlers across all
registered wallet kinds.

Per-kind defaults:

- `evm` entries → x402 EVM handler accepting USDC (configurable)
- `solana` entries → x402 Solana + MPP Solana charge on USDC mainnet
  (configurable mint; solanaRpcUrl required)
- `tempo` entries → MPP Tempo charge via `@frames-ag/payment-tempo`
  (dynamic import; reuses pattern from faremeter-bridge)
- `delegated` entries → skipped (use `dispatch()` for those)

### New: subpath export `@frames-ag/pay/wallet`

Pay's root barrel export pulls the full catalog/manifest/MCP type
graph, which can trigger consumer-side tsc issues when the consumer's
tsconfig differs from pay's (e.g., tick on Cloudflare Workers vs pay
on Node).

Added `@frames-ag/pay/wallet` subpath export that re-exports only
wallet-registry + paid-fetch surface. Consumers who just need
wallet/payment can import from the subpath and avoid pulling
catalog/manifest/MCP types through their TS context.

### Why this exists

Tick (a sibling app) had 117 lines of buyer-side payment code that
duplicated pay's 1,565 lines of wallet/dispatch infrastructure. Both
imported `@faremeter/*` packages independently. This release lets tick
import pay's wallet surface directly — one faremeter integration point
in the monorepo. Future faremeter upgrades (e.g., switching to
`@faremeter/rides`) happen once in pay, not separately in each
consumer.

---

## 0.1.0

### Minor Changes

- 8ab69ef: Receipts now persist to disk after every paid call.

  Two-tier policy implemented per SPEC §"Frame integration":

  1. **Frame-detected** — when `PAY_FRAME_DATASET` env var is set, or cwd contains both `schema.yml` and `events.ndjson`, dispatch appends a `tool.invoked` event with the full inlined receipt to that dataset's `events.ndjson`. This is the canonical record per spec.
  2. **Fallback** — when no frame context is detected, dispatch appends to `~/.frames/pay/events.ndjson` (per-machine canonical for explicit-call mode).

  New modules:

  - `pay/src/stores/filesystem.ts` — `FilesystemStore` (append-only NDJSON), `defaultFallbackPath()`
  - `pay/src/frame/event.ts` — `detectFrameDataset()`, `appendToolInvokedEvent()`

  Persistence is wired into both dispatch paths (the regular faremeter path and the agentwallet-delegated path). Failures are non-fatal — the in-memory receipt is the canonical artifact and is still returned to the caller; disk writes are best-effort cache.

  `DispatchContext.persistence` gained an override hook for tests: `{ skipPersistence: true }` disables; `{ frameDatasetPath, store }` injects custom paths.

  New smoke: `bun run smoke:persistence` — 11 unit assertions covering env-set, cwd-heuristic, fallback, and refusal-to-bootstrap behaviors.

- 8ab69ef: `pay-mcp` now supports per-dataset manifest scoping.

  New CLI flags on `pay-mcp`:

  - `--manifest <path>` / `-m` — set `tools.yml` location explicitly
  - `--lock <path>` — set `tools.lock` location explicitly
  - `--dataset <path>` / `-d` — frame dataset directory; auto-derives `<path>/tools.yml`, `<path>/tools.lock`, AND sets the receipt destination so `tool.invoked` events land in `<path>/events.ndjson`

  Equivalent env vars: `PAY_MANIFEST_PATH`, `PAY_LOCK_PATH`, `PAY_FRAME_DATASET`. Flags win over env when both are passed.

  This unifies tool scoping with frame integration: `pay-mcp --dataset datasets/foo` is the single flag a multi-dataset repo needs to wire up bounded toolsets per frame.

  Resolution precedence in `config.ts`:

  1. `PAY_MANIFEST_PATH` / `PAY_LOCK_PATH` env (or matching CLI flags)
  2. `PAY_FRAME_DATASET` env (auto-derives both)
  3. `manifest_path` / `lock_path` in `~/.frames/pay/config.yaml`
  4. Built-in defaults (`./tools.yml`, `./tools.lock`)

  Closes the manifest-scoping gap — frames-examples can now declare per-dataset `tools.yml` files alongside `schema.yml`, and the dataset's `events.ndjson` becomes the canonical record of every paid call by that loop.

- New `kind: tempo` wallet factory.

  Lets users declare a Tempo wallet in `~/.frames/pay/config.yaml` so the bridge's existing MPP+Tempo path (lazy-loaded `@frames-ag/payment-tempo`) actually has something to consume. Two key sources:

  ```yaml
  wallets:
    tempo:
      - kind: tempo
        label: prod
        private_key: env:TEMPO_PRIVATE_KEY      # or 0x-hex literal

    # OR — reuse the agentcash EVM key (single identity for x402-on-Base + MPP-on-Tempo)
    tempo:
      - kind: tempo
        label: shared-with-agentcash
        share_with: agentcash
  ```

  The factory constructs a viem `Account` from the private key. The `share_with: agentcash` mode reads `~/.agentcash/wallet.json`'s EVM key (or `X402_PRIVATE_KEY` env override). This is the pragmatic path: you already have an agentcash wallet for x402 on Base; this lets the same key settle MPP charges on Tempo without duplicating secrets.

  Closes the wallet-config side of the catalog Gap 2 fix — MPP descriptors that name `network: tempo` are now actually dispatchable.

- 61ab7c3: `tool.invoked` events now surface tool input + response excerpt for human auditing.

  New optional `payload.tool` block alongside `payload.receipt`:

  ```json
  "payload": {
    "receipt": { ... receipt with hashes (canonical) ... },
    "tool": {
      "params": { "query": "...", "numResults": 2 },
      "response_excerpt": "{\"success\":true,\"results\":[...",
      "response_size_bytes": 12453,
      "response_truncated": true
    }
  }
  ```

  Asymmetric by design:

  - **Params verbatim** (almost always small; a half-truncated query is meaningless for replay).
  - **Response excerpted** to a byte cap (responses are often 10–80KB; the receipt's `response_hash` anchors the full body for cryptographic verification).

  Knobs (env vars):

  - `PAY_TOOL_BODY_MAX_BYTES` — response excerpt cap, default 2048.
  - `PAY_REDACT_PARAMS=true` — store `"[redacted; hash in receipt]"` instead of params (privacy mode for enrichment APIs that contain PII).
  - `PAY_INLINE_TOOL_DATA=false` — full opt-out (legacy receipt-only events).

  `ToolInvocationPayload` is a new optional type in `pay/types.ts`. Frame integration's `appendToolInvokedEvent` and `FilesystemStore.append` both gain an optional `tool` parameter. Old readers that don't know about `payload.tool` skip the unknown key per the frame protocol forward-compat rule.

  Verified live: a real paid call from inside `examples/frames-examples/datasets/layoffs-2026/` produced an event with `payload.tool.params = { query, numResults, type }` and a 2048-byte excerpt of the Exa response. Receipt's `response_hash` still anchors the full 2223-byte body.

### Patch Changes

- Fix: `tool.invoked` event excerpt is the seller body, not the agentwallet wrapper.

  The agentwallet-delegated dispatch path was passing the full agentwallet HTTP response text to `buildToolPayload`. So events captured `{ success, response: { status, headers, body: <real data> } }` — the wrapper consumed roughly half of the 2KB excerpt budget on every event.

  Now stringifies only the inner body before excerpting. Excerpts start with the seller's actual response (Exa results, Reddit posts, etc.) and fit within the default cap for typical responses — verified live, a 3-result Exa query went from 2223 bytes truncated to 1303 bytes complete.

  Receipt's `response_hash` continues to anchor the full body for cryptographic verification regardless of excerpt size.
