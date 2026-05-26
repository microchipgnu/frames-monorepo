---
name: refresher
kind: service
---

# Refresher

### Description

Re-check existing entities whose `status = announced` and `date_announced`
is older than `refresh_age_days`. Update `status` from free sources first
(company blog re-check, SEC EDGAR for new 8-Ks / 10-Q footnotes, WARN
database update). Fall back to ONE paid `serper_news` call per entity if
free sources yield nothing AND budget allows.

### Shape

- `self`: read inventory, check free sources, optionally one paid news
  call per entity, emit refresh actions
- `prohibited`: any direct frame mutation (writer applies the actions),
  more than ONE paid call per entity

### Requires

- `state`: from `inventory`
- `refresh_age_days`: minimum age of `announced` rows to refresh
- `refresh_cap`: maximum entities to refresh
- `budget_usd`: shared budget; refresher may consume a portion for its
  fallback news calls

### Ensures

- `refresh_actions`: `workspace/refresher/refresh_actions.json`, capped at
  `refresh_cap`, with one action per refreshed entity:
  `{ entity_id, action: "transition" | "no-change", new_status?, evidence_url?, notes? }`
- the action set reports `status` transitions only, not value changes — the
  writer applies them via `set_fact(status, …) + attach_evidence`

### Errors

- `RefresherBudgetGuard`: refresher would exceed its allocated portion of
  `budget_usd` — stop fallbacks; mark remaining entities `no-change` with
  a `budget-exhausted` note

### Invariants

- never proposes new entities — only acts on existing IDs
- never proposes a value change on `layoff_count` / `layoff_percentage` —
  refresher only touches `status` + adjacent evidence
- never paraphrases `reason_excerpt`
- a `partially-executed` or `rescinded` transition requires at least one
  fresh evidence URL

### Strategies

- always check the company's official IR page / blog first (free)
- for public companies, check SEC EDGAR for new 8-K or 10-Q footnotes
  mentioning the announced layoff
- for US-region entities, check the state WARN portal for new filings
- only spend a paid `serper_news` call when ALL free checks yielded nothing
  AND the entity is older than 2 × `refresh_age_days` (i.e. genuinely
  stale, worth budget)
- when a refresh discovers a new round of layoffs at the same company,
  emit a `no-change` for the existing entity and surface the new round in
  notes — let discover propose the new entity

### Tools

- `mcp:frame-layoffs-2026`: required — `query`
- `mcp:pay`: required when fallback paid news call is needed
- `cli:curl`: needed for SEC EDGAR / WARN / blog fetches
