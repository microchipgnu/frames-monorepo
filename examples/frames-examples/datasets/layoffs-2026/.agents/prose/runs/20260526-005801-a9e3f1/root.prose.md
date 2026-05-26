---
name: layoffs-discover
kind: system
---

# Discover

### Description

Search for new layoff announcements using paid tools (`serper_news`,
`exa_search`, `twitter_search`, `reddit_search`, `firecrawl_scrape`) but do
not write them to the frame. The output is a JSON file a human or a
follow-up curate run reviews.

Layoffs has no free discovery path — news/social/scrape are paid, SEC EDGAR
and WARN are useful for enrichment but rarely surface announcements first.

### Services

- `tool-picker`
- `query-planner`
- `searcher`
- `extractor`
- `dedup`

### Requires

- `frame`: path to the frame directory (default: `.`)
- `budget_usd`: ceiling for `pay_tool` spend this run (default: `0.75`)
- `min_candidates`: target deduped candidate count (default: `15`)
- `min_queries`: minimum distinct search queries the searcher must run
  before declaring done (default: `4`)
- `freshness_days`: only surface announcements within the last N days
  (default: `14`)
- `queries`: optional list of search prompts; when omitted, derive them from
  `schema.yml` description + `README.md` (still must produce
  ≥ `min_queries` distinct queries)

### Ensures

- `candidates`: `workspace/discover/candidates.json` — array of
  `{ entity_id, fields: {…}, evidence_urls: [string, …], confidence: number, authority_tier: number }`
- every candidate has at least one evidence URL
- every candidate's `entity_id` follows `<company-slug>-<YYYY-MM-DD>`
  (lowercase, hyphenated company name + date of announcement)
- every candidate's `fields` object includes at minimum `company`,
  `date_announced`, plus whichever of `layoff_count`, `layoff_percentage`,
  `sector`, `region`, `reason_stated` the search result directly evidences.
  Enrichment fields (`total_workforce_before`, `warn_filing_url`,
  `sec_filing_url`, `ceo_name`, `affected_teams`) are left for the curate
  run's free-source enricher.
- every candidate's `authority_tier` is one of: `1` (official statement /
  company blog / SEC 8-K), `2` (CEO X post or official company social), `3`
  (tier-1 news: Reuters, WSJ, FT, Bloomberg, NYT), `4` (tier-2 news), `5`
  (employee/Reddit signal only)
- every candidate `entity_id` is not already present in the frame
- `len(candidates) ≥ min_candidates` OR `workspace/discover/shortfall.md`
  exists explaining why
- the searcher ran ≥ `min_queries` distinct queries across at least 2
  different paid tools
- no frame mutations, no `events.ndjson` writes
- `spent_usd`: total settled USDC reported in the run trace, ≤ `budget_usd`

### Errors

- `BudgetExceeded`: hard-stopped because `spent_usd` would cross `budget_usd`
- `NoCatalogTool`: `tool-picker` could not resolve any of `serper_news`,
  `exa_search`, `twitter_search`, `reddit_search` against the catalog —
  abort, the catalog is misconfigured
- `WalletNotReady`: `mcp__pay__wallet_status` reports an unconfigured or
  unfunded wallet — abort before any paid call

### Invariants

- total `pay_tool` USDC across the run ≤ `budget_usd` (hard stop)
- never call `set_fact`, `add_entity*`, or `deprecate_fact`
- a candidate without at least one evidence URL is dropped, not saved with
  `null`
- never invent fields not in `schema.yml`
- never collapse multiple queries into one — distinct queries hit distinct
  slices of the search index
- never include candidates sourced ONLY from layoffs.fyi, Wikipedia, or
  AI-generated news roundups (zerohedge.com summaries, automated TLDR
  aggregators) — these are derivative, not primary
- never include candidates where the company is not identifiable
  (e.g. "a major US retailer" with no name)
- announcements older than `freshness_days` are excluded — the curate
  refresh pass handles older entities, not discover

### Strategies

- when the first news query returns fewer than `min_candidates / min_queries`
  candidates, broaden the next query (drop `2026`, widen the date range)
  rather than re-running the same one against a different tool
- when the budget is half spent and one tool is producing more candidates
  per dollar than another, drop the lower-yield queries and spend the
  remaining budget on the winner
- when evidence is thin (one weak tier-4 source), set `confidence` ≤ 0.4 and
  keep the candidate — the curate auditor decides
- when a single announcement spawns hits across news + Twitter + Reddit,
  merge them onto one candidate and keep the highest `authority_tier`
  (lower number = higher authority); store all URLs in `evidence_urls`
- when a candidate's `layoff_count` appears in multiple sources but the
  numbers conflict, leave `layoff_count` unset on the candidate, set
  `confidence` ≤ 0.5, and surface the conflict in `notes` — the curate run
  will write `status=disputed` if it decides to land the entity
- when `reddit_search` surfaces an unconfirmed rumor (employees saying
  "I just got laid off" but no company statement and no news coverage), tag
  it `authority_tier: 5` and `confidence ≤ 0.3` — don't drop, but flag for
  human review before any write
- when `twitter_search` returns a CEO post that names a number, tag
  `authority_tier: 2` and consider it primary — CEO posts are official
  statements even when not on the company blog

### Tools

- `mcp:pay`: required — `wallet_status`, `list_tools`, `pay_tool`,
  `discover`
- `mcp:frame-layoffs-2026`: required for dedup against existing entities

### Runtime

- `persist`: project
