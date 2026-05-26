# discover shortfall — 2026-05-26 (run 20260526-001729-40b8f7)

## Outcome

Zero candidates produced. Searcher could not settle any paid query — all
three attempts returned opaque `agentwallet 500` after routing to base/USDC.

## Root cause

**pay → agentwallet rail dispatch still hard-picks base/USDC.** New since
the last shortfall:

- Locked descriptors for `exa_search` + `twitter_search` now advertise 5
  accepts each (base USDC/USDT + solana USDC/USDT/CASH).
- A `solana-mainnet` wallet is now configured in pay
  (`AyyQz8tScHpiAh7S3v8XXhxHbfvfSiErLGur11SmegRc`), alongside the existing
  base wallet (`0xBd9EB8899d7207bEB35A140010E154438a25E55f`).

So the catalog side (PRs #13, #15, #16 — typed multi-rail descriptors,
registry scraper, 402-probe coverage) shipped. The wallet side also
caught up. But the dispatch path between them did not: `pay.pay_tool`
still sends only `{url, method, body}` to agentwallet; agentwallet still
picks base/USDC as primary; and there is no fallback to the
seller-advertised solana accepts on failure.

## Failure trace

| # | query                  | tool           | rail attempted | outcome                       |
|---|------------------------|----------------|----------------|-------------------------------|
| 1 | q1-exa-broad           | exa_search     | base/USDC      | agentwallet 500, paid:false   |
| 2 | q3-exa-warn            | exa_search     | base/USDC      | agentwallet 500, paid:false   |
| 3 | q5-twitter-recent      | twitter_search | base/USDC      | agentwallet 500, paid:false   |

Three different queries, two different tools, same response shape. Each
500's body began:

```
{"success":false,"paid":false,"attempts":1,"duration":<ms>,
 "payment":{"chain":"eip155:8453","amountRaw":"10000",
            "amountFormatted":"0.01 USDC","recipient":"…", …}}
```

The MCP error format truncated the body, so the typed-error contract from
PR #12 (`insufficient_funds` / `seller_rejected` / etc.) was not visible at
the call boundary even if the underlying response now carries it.

## Contract status

| field                       | value          |
|-----------------------------|----------------|
| `spent_usd`                 | 0.00           |
| `budget_usd`                | 0.20           |
| `min_candidates` (15)       | NOT met (0)    |
| `min_queries` (4)           | NOT met (0 settled) |
| `two_tool_minimum`          | NOT met (0)    |
| `BudgetExceeded`            | not triggered  |
| `WalletNotReady`            | partially triggered — wallets present but unusable |
| `NoCatalogTool`             | not triggered  |

## Remediation paths

1. **Top up the base agentwallet** — smallest unblock. `0xBd9EB8899d7…E55f`
   on Base, ≥ $0.10 USDC clears the $0.05 planned spend with a buffer.
2. **Wire rail preference through pay → agentwallet** — real fix.
   - `packages/pay/src/wallet/dispatch.ts dispatchViaAgentwallet` learns to
     forward a rail-preference param.
   - agentwallet's `/api/wallets/:user/actions/x402/fetch` honors it and
     falls through to seller-advertised alternative accepts on
     `INSUFFICIENT_BALANCE`.
3. **Replace the delegated agentwallet entry with a native solana wallet**
   — bypasses agentwallet's rail decision; `pay.selectPaymentOption`
   routes through faremeter's solana handler directly.
4. **Surface typed errors at the MCP boundary** — wire the PR #12 typed
   errors through `mcp__pay__pay_tool` so callers see
   `insufficient_funds` / `seller_rejected` / etc. and can act
   programmatically.

## Workspace artifacts produced

- `sources/{tool-picker,query-planner,searcher,extractor,dedup}.prose.md`
  — service snapshots at wiring time
- `forme.manifest.json` — compiled wiring graph
- `bindings/tool-picker/chosen_tools.json` — picked tools with rail metadata
- `bindings/query-planner/queries.json` — 5 planned queries (3 attempted)
- `bindings/searcher/raw_results.json` — per-call diagnostics
- `bindings/searcher/spent_usd.md` — 0.00
- `workspace/searcher/__error.md` — error signal that propagated the run
- `bindings/discover/shortfall.md` — this file
- `bindings/dedup/candidates.json` — NOT WRITTEN (contract honored:
  exactly one of candidates.json OR shortfall.md, never both)
