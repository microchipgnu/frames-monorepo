---
name: dedup
kind: service
---

# Dedup

### Description

Drop candidates whose `entity_id` already exists in the frame. Merge
cross-source hits for the same `(company, date_announced)` onto a single
candidate, keeping the strongest authority_tier and aggregating evidence
URLs. Emit the final candidates list (or a shortfall report when the count
falls below `min_candidates`).

### Shape

- `self`: query frame for existing entity_ids; merge same-company-same-date
  candidates; emit final list or shortfall
- `prohibited`: any frame mutation; any paid call

### Requires

- `candidates_unfiltered`: from `extractor`
- `min_candidates`: target deduped count
- `frame`: path to the frame directory

### Ensures

- when `len(final_candidates) ≥ min_candidates`:
  `candidates`: `workspace/discover/candidates.json` written; no shortfall
- when below `min_candidates`:
  `workspace/discover/shortfall.md` written explaining why; no candidates.json

### Invariants

- never publish a candidate whose `entity_id` already exists in the frame
- exactly one of `candidates.json` OR `shortfall.md` exists at the end of a
  successful run; never both, never neither
- when merging, keep the LOWEST `authority_tier` value (highest authority)
  across the merged sources; union `evidence_urls`

### Strategies

- when two candidates share `(company, date_announced)`, merge them; the
  merged row keeps the lowest (best) `authority_tier`, the union of
  `evidence_urls`, and the highest `confidence`
- when a candidate's `entity_id` already exists but a NEW source is found
  with stronger authority, do not emit it as a new candidate — the curate
  refresh pass handles "new source for existing entity"
- when the shortfall path triggers, the shortfall report must include:
  outcome, root cause, spent_usd vs budget, queries attempted, tools used,
  remediation paths; this is the contract the orchestrator falls back to

### Tools

- `mcp:frame-layoffs-2026`: required for `query` (mode=sql) to enumerate
  existing entity_ids
