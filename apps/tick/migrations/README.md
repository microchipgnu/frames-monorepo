# tick D1 migrations

D1 schema for tick's receipt store. Three tables — `runs`, `tool_calls`, `events` — joined by `run_id`.

## Apply migrations

Local dev (Miniflare-emulated):

```bash
cd apps/tick
bunx wrangler d1 migrations apply tick-receipts --local
```

Production:

```bash
bunx wrangler d1 migrations apply tick-receipts --remote
```

## Create the D1 database (one-time)

```bash
bunx wrangler d1 create tick-receipts
```

Output prints a `database_id`. Paste it into `wrangler.toml`'s commented `[[d1_databases]]` block.

## Schema overview

| Table | Rows per /run | Purpose |
|---|---|---|
| `runs` | 1 | Receipt header — op, agent, frame, budget, settled, status, payment metadata |
| `tool_calls` | N | One per paid (or free) tool invocation; cite by `(run_id, source_url)` |
| `events` | M | One per frame event written; reconstructable into events.ndjson lines |

All three share `run_id` (string `"run_<uuid>"`) and cascade-delete on `runs` removal.

Frame protocol v0.2.0+: `events.run_id` is the same value the runtime emits on every frame event envelope it writes. Anyone reading the customer's frame can join events to this table via `run_id`.

## Conventions

- USDC amounts are stored as TEXT (e.g., `"0.0125"`) to avoid float drift.
- Timestamps are ISO 8601 strings, UTC, millisecond precision.
- `agent` format matches frame's `<kind>:<identifier>` convention — `frames-runtime:<wallet-address>` for tick-emitted events.
- `descriptor_id` matches pay's content-addressed identity (`sha256-<base64url>`).
