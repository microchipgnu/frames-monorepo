---
name: enricher
kind: service
---

# Enricher

### Description

For every newly-created `entity_id`, attempt free authoritative sources in
order: SEC EDGAR (8-K + 10-K), state WARN portals, and the company's own
press release / IR page. Populate adjacent fields the writer didn't have
evidence for: `sec_filing_url`, `total_workforce_before`, `warn_filing_url`,
`official_statement_url`, `ceo_name`, `affected_teams`.

### Shape

- `self`: fetch free authoritative sources; call `set_fact` per evidenced
  field through frame MCP
- `prohibited`: any paid tool call; any `set_fact` without source

### Requires

- `writes_applied`: from `writer`
- `frame`: path to the frame directory

### Ensures

- `enrichment_applied`: `workspace/enricher/enrichment_applied.json` with
  per-entity coverage: `{ entity_id, fields_added: [], sources_attached: [] }`
- public companies (region=us) have `sec_filing_url` populated when a
  matching 8-K filed within ±30 days of `date_announced` is found
- us-region entities have `warn_filing_url` populated when a matching WARN
  notice is found
- entities pointing at a press-release URL in `evidence_urls` have
  `official_statement_url` populated and `reason_excerpt` verified verbatim
  against that page

### Errors

- `EnrichmentBlocked`: SEC EDGAR / WARN portals repeatedly fail after
  backoff — partial entities remain; surface them in the parent's
  `under_covered_entities[]`

### Invariants

- every `set_fact` carries `source.url` and `source.retrieved_at`
- no paid tool calls
- when SEC EDGAR returns no 8-K within ±30 days for a public company, set
  `sec_filing_url` to NULL (don't fabricate)
- never paraphrase `reason_excerpt` when verifying — it must remain verbatim

### Strategies

- SEC EDGAR URL pattern:
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=<slug>&type=8-K`
- when SEC EDGAR rate-limits (429), back off 60s and retry up to 3 times
  before declaring `EnrichmentBlocked` for that entity
- prefer the company's IR / press-release page over generic press coverage
  for `official_statement_url`
- when the press release names `affected_teams` explicitly (e.g.
  "X division, Y region"), populate it verbatim; otherwise leave NULL
- when the WARN notice gives a different `layoff_count` than the press
  release, do NOT overwrite the press-release value — emit a note for the
  auditor to flag a potential dispute

### Tools

- `mcp:frame-layoffs-2026`: required — `set_fact`, `attach_evidence`
- `cli:curl`: needed for free fetches (SEC, WARN, company sites)
