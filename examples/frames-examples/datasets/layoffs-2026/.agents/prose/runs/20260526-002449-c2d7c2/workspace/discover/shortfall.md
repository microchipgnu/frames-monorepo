---
run_id: 20260526-002449-c2d7c2
system: layoffs-discover
outcome: shortfall
status: failed
exit_node: searcher
exit_error: AllCallsFailed
candidates_emitted: 0
min_candidates_target: 15
spent_usd: 0.00
budget_usd: 0.20
---

# Discover shortfall — run 20260526-002449-c2d7c2

## Outcome

System aborted at `searcher` with `AllCallsFailed`. Zero candidates produced.
No frame mutations. Hard-stop budget invariant held (spent $0.00 of $0.20).

## Root cause

All 4 planned `mcp__pay__pay_tool` calls (3× `exa_search`, 1× `twitter_search`)
returned **opaque `agentwallet 500`** on the `base/USDC` rail
(`eip155:8453`, 0.01 USDC each, recipient
`0xe62923133a417cEe4241677865Ed5a63F44F4B54`). Every call: `success=false`,
`paid=false`, `attempts=1`.

The error surface was opaque — not a typed `insufficient_funds` — so the
searcher's documented rail-preference retry did not fire. Even though
`pay.wallet_status` shows a `solana-mainnet` wallet configured and both
locked descriptors advertise five accepts (base USDC/USDT, solana
USDC/USDT/CASH), the pay→agentwallet dispatch hard-picked `base/USDC` for
every call and failed there. No second rail was attempted at the MCP
boundary.

This is the **same failure mode** as run `20260526-001729-40b8f7` ~5 minutes
prior — the pay multi-rail dispatch gap is still load-bearing for layoffs
discover.

## What we did try

- Wallet preflight: both `base` and `solana-mainnet` agentwallet wallets
  present in `mcp__pay__wallet_status`.
- 4 queries planned across 4 distinct slices and 2 tools (exa_search ×3
  semantic slices, twitter_search ×1 social slice), total est cost $0.04
  well under the $0.20 ceiling.
- Each call attempted exactly once; no double-calls; no extra paid calls.

## What we did NOT try (and why)

- **Re-attempt on solana rail.** The pay client at the MCP boundary did
  not surface a typed `insufficient_funds` error, and there is no
  `pay_tool` parameter today to force `rail_preference: solana-mainnet/USDC`.
  The strategy guidance is "ONE retry if typed insufficient_funds AND pay
  client supports rail hint" — neither precondition held.
- **Free fallback sources.** Layoffs has no free discovery path —
  news/social/scrape are paid. SEC EDGAR + WARN are enrichment paths, not
  discovery surfaces, and would not satisfy `min_candidates ≥ 15` for the
  14-day window on their own.
- **mpp-rail tools.** `serper_news`, `reddit_search`, `firecrawl_scrape`
  pay on tempo (mpp); no tempo wallet is configured, so they were
  rejected by `tool-picker`.

## Remediation paths (caller's choice)

1. **Fund base/USDC** for agentwallet `0xBd9EB8899d7207bEB35A140010E154438a25E55f`
   (the funder side of the dispatch) and retry. If the 500 is "no funds
   on base", a top-up clears the dispatch and the next run settles.
2. **Fix pay→agentwallet dispatch** to honor multi-rail descriptors and
   try the next funded rail (solana/USDC) when base 500s. The catalog
   already records the descriptor accepts; only the dispatcher hard-picks
   base. Tracked in the monorepo as the "pay multi-rail dispatch gap."
3. **Type the agentwallet 500.** If the underlying failure is a typed
   `insufficient_funds` upstream of the agentwallet layer, surfacing it
   through the MCP boundary lets the searcher's rail-preference retry
   fire as designed. Today the body is truncated to opaque "agentwallet
   500" and the typed signal is lost.
4. **Add a tempo wallet** so `serper_news` becomes payable and gives
   discover an mpp fallback when x402v2 dispatch is unhealthy.

## Audit pointers

- `bindings/searcher/raw_results.json` — per-call diagnostics, truncated
  error bodies.
- `bindings/searcher/spent_usd.md` — $0.00.
- `bindings/tool-picker/chosen_tools.json` — selected tools + advertised rails.
- `bindings/query-planner/queries.json` — full plan.
- `forme.manifest.json`, `root.prose.md`, `sources/` — wired graph snapshot.
