---
"@frames-ag/pay": minor
---

fix(pay): preserve full upstream response body on DispatchError; classify aggregated rail failures

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
