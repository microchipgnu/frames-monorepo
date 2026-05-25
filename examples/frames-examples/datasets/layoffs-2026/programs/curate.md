---
name: layoffs-curate
kind: program
---

Full daily tick for `layoffs-2026`: inventory the frame, refresh existing
rows whose status may have changed (announced → executed / rescinded / etc.),
discover new layoff announcements via paid tools, write everything through
the frame MCP server, enrich newly-created entities from free authoritative
sources (SEC EDGAR, state WARN portals), and audit every new fact for
evidence quality, source-authority ordering, and schema-field coverage.

### Requires

- `frame`: path to the frame directory (default: `.`)
- `budget_usd`: total USDC ceiling across all `pay_tool` calls (default: `1.50`)
- `min_new_entities`: discovery target — fewer than this triggers fallback
  queries (default: `10`)
- `freshness_days`: discovery window for new announcements (default: `14`)
- `refresh_age_days`: only refresh existing entities where
  `status = announced` AND `date_announced` is older than this (default: `14`)
- `refresh_cap`: maximum entities to refresh per run, parallelism aside
  (default: `30`)
- `min_field_coverage`: per-entity ratio of `set_fact` calls to schema fields
  with free authoritative evidence available; below this the auditor flags the
  entity (default: `0.6`)

### Ensures

- `report`: `workspace/curate/report.json` shaped as
  `{ added, refreshed, enriched, deprecated, sources_attached, spent_usd, rejected_by_auditor, disputed[], under_covered_entities[], status_transitions[] }`
- every new fact written carries `source.url` and `source.retrieved_at`
- every newly-created entity has `set_fact` calls for at minimum: `company`,
  `date_announced`, plus whatever the discoverer's evidence supports of
  `layoff_count` / `layoff_percentage` / `sector` / `region` /
  `reason_stated` / `reason_excerpt`. Public companies additionally have
  `sec_filing_url` populated when the enricher finds a matching 8-K.
- every newly-created entity reaches `field_coverage ≥ min_field_coverage`
  OR appears in `report.under_covered_entities[]` with the reason
- every newly-created entity has an `entity_id` of the form
  `<company-slug>-<YYYY-MM-DD>`
- every conflict between sources on `layoff_count` resolves to
  `status = disputed` with `reason_excerpt` quoting the conflict — entity
  appears in `report.disputed[]`
- every rejected fact has a corresponding `fact.deprecated` event
- every status transition (`announced` → `executed` / `rescinded` /
  `partially-executed` / `disputed`) is recorded in
  `report.status_transitions[]`
- `added` count ≥ `min_new_entities` when the budget permits AND the schema's
  inclusion bar admits that many candidates from the discovery window

### Invariants

- total `pay_tool` USDC ≤ `budget_usd` across the whole run (hard stop)
- never `set_fact` without a `source` in the same call
- never call `remove_entity`
- all writes go through `mcp__frame-layoffs-2026__*` — no direct edits to
  `events.ndjson` or files under `.frame/`
- if the auditor rejects a fact, the writer immediately deprecates it; the
  rejected fact is NOT left in place
- never invent fields not in `schema.yml`
- never paraphrase `reason_excerpt` — it must be a verbatim 1–3 sentence
  quote from the cited source. Paraphrased excerpts are auditor-rejected.
- **Source-authority order is enforced**: when multiple sources disagree on
  `layoff_count`, `layoff_percentage`, `reason_excerpt`, or
  `affected_teams`, prefer in this order: (1) official company statement,
  (2) SEC 8-K filing, (3) state WARN notice, (4) CEO X post, (5) tier-1
  news, (6) tier-2 news. Lower-tier sources are kept on adjacent fields
  (`status`, `social_signal`) but never overwrite higher-tier values.
- never leave a newly-created entity with only `company` + `date_announced`;
  either enrich it from at least one additional source OR deprecate the
  partial facts and report the entity as skipped
- never include layoffs.fyi, Wikipedia, or AI-generated news roundups as
  citations — these are derivative
- never propose an entity whose company is not identifiable (no
  "a major US retailer" placeholders)
- SEC EDGAR and WARN portals are free — always attempt them for public-
  company / US-region entities before declaring the enricher done
- entities whose `date_announced` falls outside calendar 2026 are dropped at
  the writer stage (the schema's scope is explicit)

### Services

- `inventory`: reads current state via `mcp__frame-layoffs-2026__query`
  (mode=`all`); ensures `workspace/inventory/state.json` AND a list of
  existing `entity_id`s grouped by `status`
- `refresher`: re-checks existing entities whose `status = announced` and
  `date_announced` is older than `refresh_age_days`. For each, attempts free
  sources first (company blog re-check, SEC EDGAR for new 8-Ks/10-Q footnotes,
  WARN database update). Falls back to ONE paid `serper_news` call per entity
  if free sources yield nothing AND budget allows. Ensures
  `workspace/refresher/refresh_actions.json` capped at `refresh_cap`
- `tool-picker`: picks paid search tools from `tools.yml` via
  `mcp__pay__discover` + `mcp__pay__list_tools`; ensures
  `workspace/tool-picker/chosen_tools.json` ranked by price/recall
- `discoverer`: identical contract to `layoffs-discover` but invoked
  in-process here. Calls `mcp__pay__pay_tool` with the chosen tools, running
  ≥ 4 distinct queries; ensures `workspace/discoverer/new_candidates.json`
  with `≥ min_new_entities` deduped candidates OR a documented shortfall
- `writer`: applies refresher actions and the **initial** field set from
  discoverer candidates (`company`, `date_announced`, plus discoverer-
  evidenced fields, plus `status = announced` as a default) through frame
  MCP; ensures `workspace/writer/writes_applied.json` with `fact_id`s and the
  list of newly-created `entity_id`s for the enricher to pick up
- `enricher`: for every newly-created `entity_id`, attempts free
  authoritative sources in order:
  - SEC EDGAR (`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=<slug>&type=8-K`)
    for public companies → populates `sec_filing_url` and
    `total_workforce_before` (from latest 10-K) when matched
  - State WARN portal (varies by state — California's EDD, NY DOL, etc.)
    when `region = us` → populates `warn_filing_url` and corroborates
    `layoff_count`
  - Direct fetch of the company's investor-relations or press-release page
    when discoverer evidence pointed there → populates
    `official_statement_url` and verifies `reason_excerpt` verbatim
  Each fact carries the upstream URL as `source`. Ensures
  `workspace/enricher/enrichment_applied.json` with per-entity coverage.
- `auditor`: for each newly-written fact, fetches the cited URL and judges
  whether the value is directly supported. Specifically:
  - rejects facts whose source URL is paywalled but whose value cannot be
    confirmed from the excerpt alone
  - rejects `reason_excerpt` values that are paraphrased rather than verbatim
  - rejects any fact citing layoffs.fyi, Wikipedia, or known AI-summary hosts
  - detects `layoff_count` conflicts across the entity's sources and emits
    `set_fact(status, "disputed")` + `set_fact(reason_excerpt, <conflict-quote>)`
    instead of rejecting either number
  - computes `field_coverage` per newly-created entity and flags entities
    below `min_field_coverage` into `report.under_covered_entities[]`
  Emits `deprecate_fact` for unsupported claims. Ensures `report`.

### Strategies

- when evidence is thin, prefer fewer high-confidence facts over many
  speculative ones
- when the discoverer's first query returns fewer than
  `min_new_entities / 3` candidates, broaden the query (drop the year,
  widen the date) before trying another tool
- when refresh and discover would both touch the same entity (rare —
  refresh runs against existing IDs, discover proposes new ones — but it
  happens when a company announces a second round), refresh first so the
  writer sees current state before adding new facts
- when half the budget is spent and the discoverer is still under
  `min_new_entities`, fall back from `exa_search` (semantic, expensive) to
  `serper_news` (cheaper, higher-precision for fresh news)
- when the auditor rejects more than 25% of new facts, stop discovery for
  this run and let a human review the trace — that signal usually means
  one of the chosen paid tools is returning hallucinated sources
- when SEC EDGAR rate-limits the enricher, slow down (60s backoff) and
  continue — do NOT skip enrichment, do NOT leave entities partial
- when a company has multiple distinct layoff rounds in 2026, treat each
  as its own entity (`<slug>-<YYYY-MM-DD>`); never merge into one row
- when a CEO X post (`authority_tier: 2`) and a tier-1 news article
  disagree on `layoff_count`, prefer the CEO post — it's an official
  statement per the source-authority order
- when a `reason_stated` enum doesn't match the source's framing exactly,
  prefer `other` + `reason_excerpt` over forcing a bad enum bucket

### Errors

- `BudgetExceeded`: hard-stopped because `spent_usd` would cross `budget_usd`
- `NoCatalogTool`: `tool-picker` could not resolve any paid search tool —
  abort
- `WalletNotReady`: `mcp__pay__wallet_status` reports an unconfigured or
  unfunded wallet — abort before any paid call
- `EnrichmentBlocked`: SEC EDGAR / WARN portals repeatedly fail after
  backoff — partial entities remain in the frame, listed in
  `report.under_covered_entities[]`
- `SchemaViolation`: discoverer produced a candidate with `date_announced`
  outside 2026 — writer drops it and the discoverer is told to filter
  better next run

### Execution

inventory → (refresher ∥ (tool-picker → discoverer)) → writer → enricher → auditor
