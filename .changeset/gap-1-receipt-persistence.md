---
"@frames-ag/pay": minor
---

Receipts now persist to disk after every paid call.

Two-tier policy implemented per SPEC §"Frame integration":

1. **Frame-detected** — when `PAY_FRAME_DATASET` env var is set, or cwd contains both `schema.yml` and `events.ndjson`, dispatch appends a `tool.invoked` event with the full inlined receipt to that dataset's `events.ndjson`. This is the canonical record per spec.
2. **Fallback** — when no frame context is detected, dispatch appends to `~/.frames/pay/events.ndjson` (per-machine canonical for explicit-call mode).

New modules:
- `pay/src/stores/filesystem.ts` — `FilesystemStore` (append-only NDJSON), `defaultFallbackPath()`
- `pay/src/frame/event.ts` — `detectFrameDataset()`, `appendToolInvokedEvent()`

Persistence is wired into both dispatch paths (the regular faremeter path and the agentwallet-delegated path). Failures are non-fatal — the in-memory receipt is the canonical artifact and is still returned to the caller; disk writes are best-effort cache.

`DispatchContext.persistence` gained an override hook for tests: `{ skipPersistence: true }` disables; `{ frameDatasetPath, store }` injects custom paths.

New smoke: `bun run smoke:persistence` — 11 unit assertions covering env-set, cwd-heuristic, fallback, and refusal-to-bootstrap behaviors.
