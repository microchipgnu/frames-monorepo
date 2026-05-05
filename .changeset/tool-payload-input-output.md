---
"@frames-ag/pay": minor
---

`tool.invoked` events now surface tool input + response excerpt for human auditing.

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
