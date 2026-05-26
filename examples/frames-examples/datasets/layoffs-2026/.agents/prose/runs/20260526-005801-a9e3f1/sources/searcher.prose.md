---
name: searcher
kind: service
---

# Searcher

### Description

Run each planned query exactly once via `mcp__pay__pay_tool`. Honor the
per-run USDC budget as a hard stop. Surface paid-call diagnostics in the run
trace so the orchestrator can decide whether to continue or shortfall.

### Shape

- `self`: invoke `pay_tool` per query; record results + spend
- `prohibited`: any frame mutation; any extra paid call beyond the planned
  queries

### Requires

- `queries`: from `query-planner`
- `budget_usd`: hard ceiling

### Ensures

- `raw_results`: array keyed by query id, each entry
  `{ query_id, tool, settled: bool, paid_usd, body?, error? }`
- `spent_usd`: sum of settled paid calls; never exceeds `budget_usd`

### Errors

- `BudgetExceeded`: settling the next call would push `spent_usd` past
  `budget_usd` — stop without making the call
- `WalletNotReady`: `mcp__pay__wallet_status` shows no configured wallet
  for any rail any planned query needs — abort the run cleanly with no calls
- `AllCallsFailed`: every planned call returned a non-2xx with no settlement
  — surface diagnostics; parent system writes shortfall.md

### Invariants

- exactly one paid call per planned query (no double-calls)
- never call a tool that is not in the plan
- hard stop on `spent_usd ≥ budget_usd` — never settle one more "just to see"
- record the rail (`chain`, `currency`) the call settled on, when available

### Strategies

- when a call fails with a typed `insufficient_funds` error and the
  descriptor advertises an additional rail with a configured wallet, retry
  ONCE with a rail-preference hint if the pay client supports it
- when a call returns opaque `agentwallet 500`, capture the truncated body
  in `error` and continue to the next query — do not block the whole run on
  one tool's dispatch failure
- when budget is half spent and one tool is producing zero settlements,
  drop its remaining queries from the plan and continue

### Tools

- `mcp:pay`: required — `pay_tool`, `wallet_status`
