---
name: writer
kind: service
---

# Writer

### Description

Apply refresher actions and the initial field set from discoverer
candidates through the frame MCP server. Newly-created entities land with
`status = announced` and the discoverer-evidenced fields; enrichment of
adjacent fields belongs to the enricher.

### Shape

- `self`: call `mcp__frame-layoffs-2026__add_entity_with_facts` for new
  candidates; `set_fact` for refresher transitions; `attach_evidence` for
  refresher evidence updates
- `prohibited`: any paid call, any `remove_entity`, any write that lacks a
  `source`

### Requires

- `refresh_actions`: from `refresher`
- `new_candidates`: from `dedup`
- `frame`: path to the frame directory

### Ensures

- `writes_applied`: `workspace/writer/writes_applied.json` with
  `{ new_entities: [{ entity_id, fact_ids: [] }], status_transitions: [{ entity_id, new_status, fact_id }] }`
- every new entity has `set_fact(company, …)` + `set_fact(date_announced, …)`
  + `set_fact(status, "announced")` at minimum
- every `set_fact` carries `source.url` and `source.retrieved_at`

### Errors

- `SchemaViolation`: a candidate's `date_announced` falls outside calendar
  2026 — drop the candidate; surface in run trace; do not write any fact
  for it

### Invariants

- never `set_fact` without a `source` in the same call
- all writes go through `mcp__frame-layoffs-2026__*` — never direct edit
  `events.ndjson`
- never `remove_entity`
- entities whose `date_announced` falls outside 2026 are dropped here
  (scope is calendar-2026)
- when an entity_id collides with an existing entity (race with another
  run), the writer skips the candidate and logs the collision

### Strategies

- prefer `add_entity_with_facts` over separate `add_entity` + `set_fact`
  calls — atomic add reduces partial-state risk
- order the fact set within an `add_entity_with_facts` call by descending
  authority (official statement first, news second) so the index reflects
  the canonical evidence
- when the same entity has both a refresh transition AND a new fact from
  discovery, apply the refresh transition first

### Tools

- `mcp:frame-layoffs-2026`: required — `add_entity`,
  `add_entity_with_facts`, `set_fact`, `attach_evidence`
