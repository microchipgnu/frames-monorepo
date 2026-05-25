---
"@frames-ag/pay": minor
---

feat(pay): runtime fallback across `payment.accepts[]` rails when a dispatch attempt fails

Before: `selectPaymentOption` picked the first option whose bridge built cleanly and (under `"block"`) whose balance covered `price_hint`. If THAT option's dispatch then failed at runtime (agentwallet `500`, seller `5xx`, etc.), `payForTool` threw without trying the remaining `accepts[]` options. For agentwallet-delegated wallets specifically, this was painful because the balance check is bypassed for delegated bridges — so the dispatcher always selected the primary rail even when its wallet was empty, only to throw on the first call.

After: `payForTool` loops over `[primary, ...accepts[]]`. For each option it calls a new per-option helper `selectForOption`, then runs the dispatch. A `DispatchError` or `InsufficientBalanceError` from dispatch means "try the next rail" — non-pay exceptions (TypeErrors, etc.) still bubble immediately. Only when every option is exhausted does `payForTool` throw, with an aggregated message listing both selection-time and runtime failures.

Additionally, `dispatchViaAgentwallet` now sends a `payment_rail` hint in the request body so agentwallet can honor the dispatcher's per-option choice when its server supports rail preference. Older agentwallet versions ignore unknown body keys; newer versions can loop through rails per attempt as the dispatcher does.

Verified 2026-05-25 against the layoffs-2026 discover run: `prose run discover` against the multi-rail exa descriptor was failing at the first agentwallet `500` even though four other rails were available in `accepts[]`. With this change the dispatcher walks all of them.

Internal refactor: `selectPaymentOption` is replaced by `buildOptionList` + `selectForOption` + the per-option loop in `payForTool`. The dispatch-after-selection logic is extracted into `dispatchAfterSelection`. No external API change — `payForTool`'s signature and return shape are unchanged.

New test: `packages/pay/test/multi-rail-fallback.test.ts` pins the aggregated-error shape (all attempted networks named, count agrees) and the single-rail regression case.
