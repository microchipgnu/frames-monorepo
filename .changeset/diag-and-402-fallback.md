---
"@frames-ag/tick": patch
"@frames-ag/frame": patch
---

paidFetch diagnostics, post-branch logging, 402-leak fallback

Three changes from probing layoffs-2026 in prod and seeing the same Locus/MPP 402 leak before and after wiring paidFetch into the POST branch.

**Diagnostics on /health** — `/health.wallets.paid_fetch` now exposes the booted-wallet handler counts (`handlerCount`, `mppHandlerCount`, `configured.{evm,solana,tempo}`). Tells you whether the Solana MPP charge handler actually got registered or boot silently dropped it.

**Structured log inside dispatchToolInvoke POST branch** — `tool_invoke_post_response` (info) and `tool_invoke_post_threw` (error) capture status, elapsed_ms, paid_fetch_present, error stack. Surfaces whether wrap() saw the 402 and tried, or whether the handler threw inside the call. Read via `wrangler tail`.

**402-leak fallback (the user-visible fix)** — when a 402 reaches the probe builder, paidFetch already tried to satisfy it and couldn't. Mark `kind: "payment_unhandled"` and `retryable: false`. Agent prompt now says: on `payment_unhandled`, do NOT retry the same descriptor — call `catalog_search` again and prefer a result with a different `payment.protocol` or `payment.network`. Without this fix the agent was grinding on the same Solana/Locus descriptor every iter despite having Base + Tempo funds available.

`@frames-ag/frame` patch adds `payment_unhandled` to the documented `catalog.probe` hint-kind vocabulary in PROTOCOL.md and the `CatalogProbePayload` type.
