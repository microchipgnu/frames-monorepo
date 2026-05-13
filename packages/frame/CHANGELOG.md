# @frames-ag/frame

## 0.3.1

### Patch Changes

- 4b4ecec: paidFetch diagnostics, post-branch logging, 402-leak fallback

  Three changes from probing layoffs-2026 in prod and seeing the same Locus/MPP 402 leak before and after wiring paidFetch into the POST branch.

  **Diagnostics on /health** — `/health.wallets.paid_fetch` now exposes the booted-wallet handler counts (`handlerCount`, `mppHandlerCount`, `configured.{evm,solana,tempo}`). Tells you whether the Solana MPP charge handler actually got registered or boot silently dropped it.

  **Structured log inside dispatchToolInvoke POST branch** — `tool_invoke_post_response` (info) and `tool_invoke_post_threw` (error) capture status, elapsed_ms, paid_fetch_present, error stack. Surfaces whether wrap() saw the 402 and tried, or whether the handler threw inside the call. Read via `wrangler tail`.

  **402-leak fallback (the user-visible fix)** — when a 402 reaches the probe builder, paidFetch already tried to satisfy it and couldn't. Mark `kind: "payment_unhandled"` and `retryable: false`. Agent prompt now says: on `payment_unhandled`, do NOT retry the same descriptor — call `catalog_search` again and prefer a result with a different `payment.protocol` or `payment.network`. Without this fix the agent was grinding on the same Solana/Locus descriptor every iter despite having Base + Tempo funds available.

  `@frames-ag/frame` patch adds `payment_unhandled` to the documented `catalog.probe` hint-kind vocabulary in PROTOCOL.md and the `CatalogProbePayload` type.

## 0.3.0 — 2026-05-13 (catalog.probe runtime telemetry)

Adds `catalog.probe` as a new optional event type for runtime-emitted telemetry. Lets runtimes (e.g. `@frames-ag/tick@^0.4.4`) record paid-tool-call failures with structured hints so downstream analysis can answer "which catalog entries need richer metadata" without re-running probes.

### Added

- New event type `catalog.probe` in `EventType` union (`src/types.ts`). Payload: `{ tool_id, descriptor_id, args, status, hints, summary, response_excerpt, retryable }`. Hint kinds: `missing_field` / `invalid_value` / `auth_required` / `rate_limited` / `not_found` / `server_error` / `unknown`.
- `CatalogProbePayload` type exported alongside other payload types.
- Projector gets an explicit no-op case for `catalog.probe` — telemetry doesn't affect rows; the event log retains it for analysis.
- `PROTOCOL.md` documents both `catalog.probe` (new) and `tool.invoked` (previously in the type union but undocumented). Both are runtime-telemetry: projection-ignored, event-log-retained.

### Forward-compatibility

Additive change. Existing events.ndjson files remain valid. Older readers skip `catalog.probe` via the spec's "unknown event types must be skipped" rule. The wire format, projection algorithm, source schema, and schema.yml field vocabulary are unchanged.

## 0.2.0

### Minor Changes

- **`run_id` on the event envelope (optional).** New top-level field on every event that lets external runtimes correlate events written during a single curation tick. Older readers ignore it; the projector treats it as opaque metadata for now. Tick (the hosted frame runtime) uses it to join its tool log to the events it writes. Spec change documented in [PROTOCOL.md § Event envelope](./PROTOCOL.md#event-envelope).

- **`facts.set_many` event type (new).** Atomic bulk-write of multiple facts to a single entity in one envelope. Semantically equivalent to N `fact.set` events with the same outer `ts`, but committed atomically — no partial failures. Use case: tick services that compute many fields from one source page emit one `facts.set_many` instead of N `fact.set`. Projector handles it identically to N `fact.set` events, sharing the outer envelope's `ts` and `agent`. Spec at [PROTOCOL.md § Event types](./PROTOCOL.md#event-types).

- **`PROTOCOL_VERSION` bumped to `0.2.0`** in `src/types.ts`. Schema files SHOULD declare `frame_protocol: 0.2.0` once they rely on either new feature.

### Forward-compatibility

Both additions are forward-compatible: existing events.ndjson files remain valid; older readers skip the new event type per the spec's "unknown event types must be skipped" rule and ignore the optional `run_id` field. Writers MAY continue emitting N `fact.set` events instead of `facts.set_many` during the v0.2.x window.

### Follow-up work (queued for v0.2.1)

- MCP write tools accept optional `run_id` input parameter, threaded through to the emitted event envelope.
- MCP tool `set_facts_atomic` emits one `facts.set_many` event instead of N `fact.set` events when called with multiple facts on one entity.
- Test coverage for both new behaviors.

## 0.1.1

### Patch Changes

- c197ef1: Bulk `set_facts` / `add_entity_with_facts` now accept an optional per-fact `excerpt`, overriding the batch `source.excerpt` for that field. Pass `""` to suppress the batch excerpt on fields the quote doesn't substantiate (e.g. timestamps). Fixes the bug where every field in a bulk write surfaced the same quote regardless of what it actually substantiated.

## 0.1.0

### Minor Changes

- 2159261: Frame engine now indexes and surfaces `tool.invoked` events.

  Three changes work together:

  1. **Source.receipt_id** (new optional field on `Source`)

     ```ts
     { url, retrieved_at, title?, archive_url?, excerpt?, receipt_id? }
     ```

     Lets a single fact link forward to the paid call that produced its source URL — tying frame's evidence trail to pay's receipts. Forward-compatible: older readers ignore. Stored in `facts.source_receipt_id` and `evidence.source_receipt_id` SQL columns; surfaced in `--with-sources` query output.

  2. **`tool.invoked` event type, indexed in projection.** New SQL table `tool_invocations` with the full receipt + optional input/output excerpt:

     ```
     event_id PK, receipt_id, ts, agent,
     tool_id, tool_local_name, descriptor_id, params_hash, protocol,
     wallet_id, wallet_address, amount, currency, network,
     tx_hash, request_hash, response_hash, signature,
     params_json, response_excerpt, response_size_bytes, response_truncated
     ```

     Indexed on `receipt_id` and `ts`. The projector dedupes by outer event id (so `frame verify` replays don't double-count).

  3. **CLI surfaces.**
     - `frame query [<path>] --tool-invocations` — dumps every paid call, one JSON-per-line row.
       Optional filters: `--since <iso>`, `--tool-id <id|local-name>`, `--limit <n>`.
       Stderr summary: `◇ N tool.invoked events; total: $X CURRENCY[, ...]`.
     - `frame doctor` — events.ndjson check now includes per-type breakdown
       (e.g. `87 fact.set, 9 entity.created, 5 tool.invoked`) and adds a
       "paid calls" row when `tool.invoked` events are present.
     - `--sql` mode also works on the new table:
       `frame query <path> --sql "SELECT tool_id, COUNT(*), SUM(CAST(amount AS REAL)) FROM tool_invocations GROUP BY tool_id"`

  The `tool_invocations` table is what closes the audit loop: every paid call by every loop tick, queryable with the same surface as facts and entities. Combined with `Source.receipt_id` (when prompts thread it), each fact links to the receipt that produced it; each receipt has a verifiable Ed25519 signature.

  Verified live on `examples/frames-examples/datasets/layoffs-2026` (5 real `tool.invoked` events from the layoffs-2026 prompt's earlier session) — cost rollup, query output, and doctor summary all reflect the real data.

  Forward-compatible: existing `events.ndjson` files without `tool.invoked` events have empty `tool_invocations` tables; nothing changes for current callers.
