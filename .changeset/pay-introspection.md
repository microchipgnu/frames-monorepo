---
"@frames-ag/pay": minor
---

feat(pay): typed errors, balance preflight, descriptor drift check

Three changes to make the failure modes from `pay_tool` actionable, motivated by the layoffs-2026 OpenProse discover run on 2026-05-25 that consumed three paid attempts before surfacing that the base wallet was empty.

**`wallet_status` reports balances.** The MCP tool and `pay wallet status` CLI now probe each configured wallet's balance in USDC (and CASH on Solana) by default. Programs can now fail-fast in preflight on `WalletNotReady` when a wallet exists but is unfunded, instead of running the full plan and hitting `agentwallet 500` mid-flight. Skip with `include_balances=false` (MCP) or `--no-balances` (CLI) for an offline-only summary.

**`pay_tool` returns typed errors.** Failures now come back as structured `{ kind, message, retryable, details?, cause? }` instead of opaque strings. `kind` is one of `insufficient_funds | network_unconfigured | agentwallet_unreachable | seller_rejected | balance_check_failed | wallet_signing_error | descriptor_mismatch | unknown`. Programs can branch on `kind` to implement the OpenProse `WalletNotReady` / `BudgetExceeded` / `NoCatalogTool` invariants reliably. The classifier (`classifyPayError`) is exported from the package index so non-MCP consumers can use it too.

**New `check_descriptor_drift` MCP tool.** Compares each locked tool's descriptor against the live catalog and reports per-field diffs (focused on `payment.*`, `invocation.*`, `capabilities` by default). Free; one HTTP GET per locked tool. Programs should call this in preflight before a paid run so callers can spot a seller that changed rails since the lock was written — without needing to spoof the lockfile to find out (which was the only way to diagnose it before this change).
