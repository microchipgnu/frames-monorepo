---
name: applier
kind: service
---

# Applier

### Description

Consume a classifier result and apply the consequences to the frame.
Deprecate dead/drifted facts. Attach evidence for redirected sources.
Surface paywalled/blocked/quota rows in the report without mutating them.

### Shape

- `self`: call `deprecate_fact` and `attach_evidence` through the frame MCP
- `prohibited`: any `set_fact`, `add_entity*`, `remove_entity`, any `pay_tool`
  call, any direct edit of `events.ndjson`

### Requires

- `classified`: array from `classifier`
- `frame`: path to the frame directory

### Ensures

- `report`: `workspace/refresh/report.json` with
  `{ deprecated, evidence_attached, unchanged, paywalled, blocked, quota_skipped }`
- every `dead` row produces `deprecate_fact(reason="source-unreachable")`
- every `content_changed` row produces `deprecate_fact(reason="content-drift")`
- every `redirect` row produces `attach_evidence(source={url, retrieved_at: now})`
- every `ok` / `paywalled` / `blocked` / `quota` row produces NO event

### Errors

- `mcp-write-failed`: a frame MCP write returned an error after one retry —
  the run reports the failed row and continues; the run is not aborted

### Invariants

- never deprecate a fact whose source is `paywalled`
- never deprecate a fact whose source is `blocked`
- never deprecate a fact whose source is `quota`
- exactly one action per row that needs action (no double-applies)
- never invoke `mcp__pay__pay_tool`

### Strategies

- when the redirect target is a same-origin canonical page (e.g. SEC archive
  move, blog slug update), attach evidence and stop — do not deprecate
- when the redirect target is a different domain (acquisition, brand merger),
  attach evidence AND log the host change in the run trace for human review
- when an `official_statement_url` is `dead` but the same entity has another
  source that survives the run, prefer `attach_evidence` of the survivor over
  deprecating

### Tools

- `mcp:frame-layoffs-2026`: required for `deprecate_fact` and `attach_evidence`.

### Runtime

- `persist`: project
