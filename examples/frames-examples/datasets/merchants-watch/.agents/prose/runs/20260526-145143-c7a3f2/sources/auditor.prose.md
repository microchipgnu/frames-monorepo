---
name: auditor
kind: service
---

# Auditor

### Description

For each fact the writer applied this run, re-fetch the cited source
URL and verify the claimed value appears in the page. Reject facts
whose source does not support them (emit `deprecate_fact`). Audit
the recognition slice harder: at least 2 independent sources, at
least one off-host. Compile the run's final report.

### Shape

- `self`: free `curl` re-fetch of every source URL; verify; emit
  `deprecate_fact` for failures; assemble report
- `prohibited`: any paid call; any `set_fact` (other than no-op
  re-attach when source URL is wrong but the value is supported on
  a corrected URL — rare)

### Requires

- `writes_applied`: from `writer`
- `frame`: path to the frame directory

### Ensures

- `report`: final `workspace/curate/report.json` per the parent
  system's contract
- every rejected fact has produced a `deprecate_fact` event with a
  human-readable reason
- the report carries the rejection histogram: `rejected_by_reason: { source_404: N, value_not_in_source: N, off_host_required: N, paraphrased: N, ... }`

### Errors

- `AuditorOverload`: rejected > 25% of curate facts — surface a
  stop-signal in the report; the orchestrator pauses curate for
  human review

### Invariants

- never `set_fact` for value fields (display_name / category /
  is_recognized) — only deprecates
- the auditor's read of a source URL is canonical; disagreements
  with the writer's claim are auditor wins
- never re-fetch a paywalled URL more than once per run — paywall is
  not failure
- the auditor itself NEVER makes paid calls; it only re-fetches
  with `curl`

### Strategies

- rejection criteria, in order of how often they fire:
  - `source_404` — cited URL returns 404 / dead host → reject
  - `value_not_in_source` — the proposed `display_name` /
    `description` / `category` evidence phrase does not appear in
    the page text → reject
  - `paraphrased` — proposed description is similar to but not
    verbatim from the page → reject (auditor enforces verbatim
    descriptions; namer's job to extract correctly)
  - `off_host_required` — recognition write with all sources on
    the host's own domain (no off-host corroboration) → reject the
    `is_recognized = true`; keep `display_name` if free home page
    supports it
  - `infra_host` — host matches infra heuristics in
    `scripts/host.ts:isInfraHost` (e.g. `*.amazonaws.com`,
    `*.vercel.app`) → reject ALL curate writes for that entity
  - `category_not_in_enum` — proposed category outside schema enum
    → reject (should have been caught at writer, but belt + braces)
- when more than 25% of facts are rejected, the report includes
  `recommend_action: "pause-curate"` so an operator can investigate
  before the next tick
- coverage metric: `curate_success_rate = (facts_applied - facts_deprecated) / facts_applied`. Surface in report so operators can track trend over time.

### Tools

- `mcp:frame-merchants-watch`: required — `deprecate_fact`, `query`
- `cli:curl`: required for re-fetching cited URLs
