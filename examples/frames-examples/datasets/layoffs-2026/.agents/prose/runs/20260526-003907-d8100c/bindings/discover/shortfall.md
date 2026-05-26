---
outcome: shortfall
program: layoffs-discover
run_id: 20260526-003907-d8100c
candidates_found: 0
min_candidates: 15
spent_usd: 0.00
budget_usd: 0.20
root_cause: pay→agentwallet payload not re-templated per selected rail
---

# layoffs-discover shortfall — 2026-05-26

## Outcome

0 deduped candidates surfaced versus a `min_candidates` target of 15. No frame mutations. No spend. The run halted at the `searcher` stage with `AllCallsFailed` and the pipeline emitted this shortfall per contract.

## Root cause

Every one of the 6 planned `pay_tool` calls returned an opaque `agentwallet 500` for every advertised rail option. The pay client's rail-fallback loop (added in commit `baaa1774c`) **did fire** — it iterated through all 5 rails in each tool's `payment.accepts[]`:

1. x402v2 / base / USDC
2. x402v2 / base / USDT
3. x402v2 / solana-mainnet / USDC
4. x402v2 / solana-mainnet / USDT
5. x402v2 / solana-mainnet / CASH

…but the actual outbound payment payload sent to agentwallet was identical on every attempt:

```
chain:     eip155:8453
currency:  USDC (amountRaw: 10000)
recipient: 0xe62923133a417cEe4241677865Ed5a63F44F4B54
```

So the rail-selection loop is selecting the next descriptor entry but the outbound payload is never re-templated for the selected rail. All 5 attempts per call collapse into 5 identical base/USDC dispatches, each of which 500s. This is a partial-fix state: catalog descriptors ✓ (multi-rail now exposed), runtime fallback control flow ✓ (loop iterates), payload templating ✗.

This is a sharper version of the gap previously logged in user memory ("pay multi-rail dispatch gap — pay→agentwallet dispatch still hard-picks base/USDC; opaque 500s not yet typed at MCP boundary"). The catalog half is now done; the dispatch/templating half is still pending.

## Spend vs. budget

| | |
|---|---|
| budget_usd | 0.20 |
| spent_usd | 0.00 |
| remaining | 0.20 |

No settlements means no refunds owed and no accounting drift — the failure is upstream of money movement.

## Queries attempted

6 queries (4 exa_search + 2 twitter_search) covering 5 distinct slices:

| id | tool | slice | settled |
|---|---|---|---|
| q1-exa-news-broad | exa_search | semantic-news-broad | no |
| q2-exa-ai-restructure | exa_search | semantic-ai-restructure | no |
| q3-exa-warn-8k | exa_search | semantic-warn-8k | no |
| q4-exa-finance-sector | exa_search | semantic-news-broad (sector-narrowed) | no |
| q5-twitter-official-posts | twitter_search | social-official-posts | no |
| q6-twitter-ceo-statement | twitter_search | semantic-ceo-statement | no |

`two_tool_minimum_satisfied: true`, `min_queries_satisfied: true` — the plan met all contract requirements at the planner stage. The breakage is purely in dispatch.

## Tools used

- `mcp__pay__list_tools` (tool-picker): catalog inspected; 5 candidate tools surfaced; 2 chosen (exa_search, twitter_search), 3 rejected (serper_news, reddit_search — tempo-only with no tempo wallet; firecrawl_scrape — out-of-role for discover)
- `mcp__pay__wallet_status` (tool-picker + searcher preflight): base + solana-mainnet both configured and healthy
- `mcp__pay__pay_tool` (searcher): 6 invocations, 0 settlements
- `mcp__frame-layoffs-2026`: not reached (dedup never ran against the frame because there were no candidates)

## Remediation paths

In rough order of leverage:

1. **Fix the pay→agentwallet payload templating** (primary). The runtime rail-loop needs to consume the selected `payment.accepts[i]` and rebuild the outbound `payment` object (chain, asset, amountRaw) per attempt — not reuse the first option's payload for every retry. Until this lands, no `pay_tool` call against agentwallet rails will settle on anything other than base/USDC, and base/USDC is currently 500-ing.
2. **Type the agentwallet 500 at the MCP boundary**. Convert the opaque body into a structured error (`insufficient_funds`, `recipient_blocked`, `chain_unsupported_by_wallet`, etc.) so callers can act on it. Right now every failure looks identical and only the truncated raw body hints at cause.
3. **Investigate why base/USDC dispatch itself is failing**. Even if multi-rail dispatch worked, the base/USDC path was the prior happy path. The opaque 500 may indicate an upstream signing/relay regression that should be diagnosed separately.
4. **Provision a tempo wallet** to unlock `serper_news` and `reddit_search`. This widens the discover funnel and gives discover an alternative rail family if base/solana both stay blocked. Lower leverage than fix #1 since the current chosen tools are already the right tools.
5. **Re-run this exact plan once #1 is fixed**. The plan is sound: 6 distinct queries, 2 tools, 5 slices, freshness window correct, $0.06 in projected cost with $0.14 headroom for retries. Cached at `bindings/query-planner/queries.json` for replay.

## Artifacts for the next run

- `bindings/tool-picker/chosen_tools.json` — reusable; reflects current multi-rail catalog state
- `bindings/query-planner/queries.json` — reusable; freshness window pinned to 2026-05-12 → 2026-05-26
- `bindings/searcher/raw_results.json` + `__error.md` — per-call diagnostics for the pay-side debugging
- `bindings/extractor/candidates_unfiltered.json` — empty (trivially correct given empty input)
