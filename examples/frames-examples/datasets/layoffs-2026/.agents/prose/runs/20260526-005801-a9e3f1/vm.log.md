# vm.log — layoffs-discover run 20260526-005801-a9e3f1

## envelope
- system: `layoffs-discover` (`kind: system`)
- source: `.agents/prose/src/discover.prose.md`
- caller args: `frame=.`, `budget_usd=0.20`, `min_candidates=15`, `min_queries=4`, `freshness_days=14`, `queries=null`
- state backend: filesystem
- prior runs: 20260526-001729, 20260526-002449, 20260526-003907 — all 3 AllCallsFailed (opaque agentwallet 500s, $0.00 settled)
- known gap (project_pay_multirail_dispatch): catalog + rail-loop are wired, but pay→agentwallet payload templating still hard-picks base/USDC. No new pay commits since baaa1774c. High prior probability of repeat shortfall.

## execution order
1. tool-picker → 2. query-planner → 3. searcher → 4. extractor → 5. dedup
