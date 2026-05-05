---
"@frames-ag/frame": minor
---

Frame engine now indexes and surfaces `tool.invoked` events.

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
