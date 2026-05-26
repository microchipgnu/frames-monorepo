---
name: query-planner
kind: service
---

# Query Planner

### Description

Derive a set of distinct search queries spanning news, semantic web, and
social — at least `min_queries` of them — sized to fit `budget_usd` against
the chosen tools' price hints.

### Shape

- `self`: read schema + README context; emit a query plan
- `prohibited`: any `pay_tool` invocation (planning is paid-call-free)

### Requires

- `chosen_tools`: from `tool-picker`
- `frame`: path to the frame directory
- `freshness_days`: discovery window
- `min_queries`: minimum number of distinct search queries
- `budget_usd`: spending ceiling — total `est_cost_usd` must fit
- `queries`: (optional) caller-provided query list; if supplied, validate
  and pass through; if absent, derive from context

### Ensures

- `queries`: `workspace/query-planner/queries.json` with
  `{ id, tool, slice, params, est_cost_usd, rationale }` entries
- `len(queries) ≥ min_queries`
- queries span at least 2 different paid tools (`two_tool_minimum_satisfied`)
- queries cover at least 3 distinct slices (`distinct_slices`)
- `sum(est_cost_usd) ≤ budget_usd`

### Invariants

- never collapse multiple queries into one — distinct queries hit distinct
  slices of the search index
- never plan a query against a tool not in `chosen_tools`
- the `freshness_window` (computed from `freshness_days`) is explicit in
  every query that supports date params

### Strategies

- canonical slice palette for layoffs discovery:
  - `semantic-news-broad`: `"company announces layoffs workforce reduction <month>"`
  - `semantic-ceo-statement`: `"CEO statement on layoffs job cuts"`
  - `semantic-warn-8k`: `"WARN notice filing 8-K SEC workforce reduction"`
  - `semantic-memo-style`: `"internal memo employees job cuts restructuring"`
  - `semantic-ai-restructure`: `"AI restructuring layoffs automation"`
  - `news-keyword`: `"layoffs <last-week-date>"` (serper_news / brave)
  - `social-official-posts`: `(layoffs OR "job cuts") -filter:retweets lang:en` (twitter_search)
  - `social-employee-signal`: `subreddit:layoffs "laid off" "announced"` (reddit_search)
- prefer one query per slice; only repeat a slice with a deliberately
  narrowed variant if budget allows
- when the available wallet rails imply a constrained tool set (e.g. only
  base-payable tools work), drop social/news slices that require tempo and
  expand the semantic palette

### Tools

- none required for the planner itself — it's pure derivation from the
  schema and chosen_tools input
