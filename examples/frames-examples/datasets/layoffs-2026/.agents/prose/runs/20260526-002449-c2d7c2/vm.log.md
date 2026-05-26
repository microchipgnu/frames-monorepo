---
run_id: 20260526-002449-c2d7c2
system: layoffs-discover
started_at: 2026-05-26T00:24:49Z
ended_at: 2026-05-26T00:29:30Z
status: failed
error: searcher.AllCallsFailed
---

# vm.log

## Phase 0 — Forme wiring

- Loaded root: `.agents/prose/src/discover.prose.md` (`kind: system`).
- Resolved 5 services from `### Services`: `tool-picker`, `query-planner`,
  `searcher`, `extractor`, `dedup`.
- Copied service sources to `sources/`.
- Built execution order from contract matching:
  `tool-picker → query-planner → searcher → extractor → dedup` (linear).
- Emitted `forme.manifest.json`.
- Caller inputs bound: `frame=.`, `budget_usd=0.20`, `min_candidates=15`,
  `min_queries=4`, `freshness_days=14`.
- 0 warnings.

## Phase 1 — Execution

1→ [input] frame ✓
1→ [input] budget_usd ✓
1→ [input] min_candidates ✓
1→ [input] min_queries ✓
1→ [input] freshness_days ✓
2→ tool-picker ✓
3→ query-planner ✓

### tool-picker — completed

- Inputs: `frame`.
- Read pay manifest (5 tools in `tools.yml`, 2 locked: `exa_search`,
  `twitter_search`). Read `wallet_status` (base + solana-mainnet configured).
- Output: `bindings/tool-picker/chosen_tools.json` with 2 ranked tools.
- `two_tool_minimum_satisfied: true`.

### query-planner — completed

- Inputs: chosen_tools, frame, freshness_days=14, min_queries=4,
  budget_usd=0.20.
- Window: 2026-05-12 → 2026-05-26 (aligns with frame's max date_announced).
- Output: `bindings/query-planner/queries.json` — 4 distinct queries
  across 4 slices and 2 tools, est total $0.04 of $0.20.
- `min_queries_satisfied: true`, `two_tool_minimum_satisfied: true`.

4→ searcher ✗ AllCallsFailed

### searcher — failed (AllCallsFailed)

- Inputs: queries (4), budget_usd=0.20.
- Wallet preflight: base + solana-mainnet wallets present.
- Attempted q1-exa-news-broad, q2-exa-warn-8k, q3-exa-ai-restructure,
  q4-twitter-official. All 4 routed to base/USDC (eip155:8453) and
  returned opaque `agentwallet 500` (paid:false, attempts:1).
- Per service strategy: a typed `insufficient_funds` error would justify a
  rail-preference retry. Returned 500s were opaque (no typed surface), so
  no retry attempted.
- 0 settled, 4 failed. spent_usd=$0.00. Hard-stop invariant held.
- Wrote `workspace/searcher/__error.md` (AllCallsFailed).
- Same failure shape as prior run `20260526-001729-40b8f7`.

### extractor — skipped

- Upstream `searcher` errored; `raw_results` empty. Downstream services
  cannot satisfy their contracts.
- `bindings/extractor/candidates_unfiltered.json` NOT written.

### dedup — skipped

- Upstream skipped. `bindings/dedup/candidates.json` NOT written.
- System-level fallback: wrote `bindings/discover/shortfall.md` per the
  discover contract `Ensures` clause.

## Phase 2 — Run close

- System returns: shortfall (no `candidates`).
- Final status: `failed` (searcher.AllCallsFailed propagated; system
  honored its shortfall contract).
- Budget audit: $0.00 of $0.20 spent. Hard-stop invariant held.

---error 2026-05-26T00:29:30Z searcher.AllCallsFailed
