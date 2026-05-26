---
name: auditor
kind: service
---

# Auditor

### Description

For each newly-written fact, fetch the cited URL and judge whether the
value is directly supported. Reject unsupported claims (emit
`deprecate_fact`). Detect cross-source conflicts on `layoff_count` and
emit `status = disputed` instead of choosing arbitrarily. Compute per-entity
`field_coverage` and flag under-covered entities for the report.

### Shape

- `self`: re-fetch cited URLs; verify; emit `deprecate_fact` for failures;
  compute coverage; assemble report
- `prohibited`: any paid call; any `set_fact` (other than `status` /
  `reason_excerpt` for `disputed` resolution)

### Requires

- `writes_applied`: from `writer`
- `enrichment_applied`: from `enricher`
- `min_field_coverage`: threshold for `under_covered_entities`
- `frame`: path to the frame directory

### Ensures

- `report`: final `workspace/curate/report.json` per the parent system's
  contract
- every rejected fact has produced a `deprecate_fact` event with reason
- entities below `min_field_coverage` appear in
  `report.under_covered_entities[]` with the reason
- entities with cross-source `layoff_count` conflicts have
  `status = disputed` and appear in `report.disputed[]`

### Errors

- `auditor-overload`: rejected > 25% of new facts — surface a stop-signal
  in the report so the orchestrator pauses discovery; do not silently keep
  burning budget

### Invariants

- never `set_fact` for value fields (count / percentage / excerpt) — only
  rejects unsupported claims or applies `disputed` resolution
- every deprecate carries a human-readable reason
- the auditor's read of a source URL is the canonical "what does this URL
  actually say" — disagreements with the writer's claim are auditor wins
- never re-fetch a paywalled URL more than once per run — paywall != fail

### Strategies

- rejection criteria:
  - paywalled URL where the value cannot be confirmed from the excerpt
    alone → reject
  - `reason_excerpt` that is paraphrased rather than verbatim → reject
  - any citation of layoffs.fyi, Wikipedia, or AI-summary hosts → reject
  - `layoff_count` that doesn't appear anywhere in the cited page → reject
- conflict resolution: when two sources for the same entity disagree on
  `layoff_count`, emit:
  - `set_fact(status, "disputed")`
  - `set_fact(reason_excerpt, "<short quote naming both numbers>")`
  rather than deprecating either source. Both URLs stay attached as
  evidence.
- coverage: `field_coverage = facts_set / schema_fields_with_free_evidence_available_for_this_entity`
  — i.e. don't penalize an entity for missing a field no free source could
  ever populate (e.g. `ceo_name` for a private company)

### Tools

- `mcp:frame-layoffs-2026`: required — `set_fact` (status / excerpt only),
  `deprecate_fact`
- `cli:curl`: needed for re-fetching cited URLs
