# run:20260526-124729-7f9757 layoffs-discover

root: src/discover.prose.md

1→ [input] frame ✓
2→ [input] budget_usd ✓
3→ [input] min_candidates ✓
4→ [input] min_queries ✓
5→ [input] freshness_days ✓
6→ [input] queries ✓ (null — planner derives)
7→ tool-picker ✓ (2 tools: exa_search rank 1, twitter_search rank 2; two_tool_minimum_satisfied=true)
8→ query-planner ✓ (12 queries / 6 slices / $0.12 est / exa×8 + twitter×4)
9→ searcher ✓ (11 settled / 1 failed agentwallet-500 / $0.11 spent of $0.20; rail=solana-mainnet/CASH)
10→ extractor ✓ (18 candidates kept / 52 dropped; tiers 1:3 2:1 4:10 5:4)
11→ dedup ✓ (14 final / 4 dropped freshness / 0 in-frame / 0 merged → shortfall.md emitted, 1 short of min 15)
---end 2026-05-26T12:58:00Z
