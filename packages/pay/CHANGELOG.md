# @frames-ag/pay

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
