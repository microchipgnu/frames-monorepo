---
name: layoffs-refresh
kind: program
---

Verify every cited source in the `layoffs-2026` frame and apply the
consequences: deprecate facts whose sources are dead or have drifted, attach
new evidence for redirected sources. No new entities, no value changes, no
paid tools.

### Requires

- `frame`: path to the frame directory (default: `.`)

### Ensures

- `report`: counts at `workspace/refresh/report.json` of
  `{ deprecated, evidence_attached, unchanged, paywalled, blocked, quota_skipped }`
- every dead source has produced a `fact.deprecated` event with reason
  `"source-unreachable"` or `"content-drift"`
- every redirected source has produced an `evidence.attached` event for the
  new canonical URL
- `paywalled`, `blocked`, and `quota` classifications produce NO events —
  they're surfaced in the report for human review only

### Invariants

- no new entities are created (`add_entity*` forbidden)
- no value changes via `set_fact` (only `deprecate_fact` + `attach_evidence`)
- every write goes through `mcp__frame-layoffs-2026__*` — never edit
  `events.ndjson` directly
- no `pay_tool` calls (the discovery loop owns paid tools, not refresh)
- never deprecate a fact whose source is `paywalled` — paywall != dead
- **never deprecate a fact whose source is `blocked`** — CDN bot-protection
  returning 403/406 to plain HTTP is not a dead source. The page is alive
  for a browser; treat it as "not re-verifiable from this runner" and leave
  it untouched. Collapsing `blocked` into `dead` would falsely deprecate
  alive sources (verified 2026-05-25: ~85% of "dead" classifications on
  this frame were bot-blocks)
- never deprecate a fact whose source is `quota` — rate-limit is transient

### Services

- `classifier`: same shape as `layoffs-verify`; ensures `classified[]`
- `applier`: consumes `classified[]`; calls `deprecate_fact` and
  `attach_evidence` exactly once per row that needs action

### Strategies

- when a URL redirects to a same-origin canonical page (e.g. `*.sec.gov`
  archive moves, or a company blog slug update), attach evidence; do not
  deprecate
- when a URL redirects to a different domain (acquisition, brand merger),
  attach evidence AND record the host change in the run trace for human
  review — domain changes for official statements are signal, not noise
- when classification is `quota` (rate limited), skip the row this run — do
  not deprecate
- when classification is `paywalled` or `blocked`, leave the fact in place
  and surface it in the report so a human can decide whether to swap the
  citation for a more accessible source. `blocked` over multiple runs is a
  signal to consider replacing the citation — but never to deprecate it
  silently
- when an official_statement_url goes dead but the underlying claim is
  corroborated by a tier-1 news source on the same entity, prefer
  `attach_evidence` of the news source over deprecating — losing one citation
  shouldn't lose a true fact

### Execution

1. Run `classifier`.
2. Run `applier` against the classified set:
   - `dead` → `deprecate_fact(reason="source-unreachable")`
   - `content_changed` → `deprecate_fact(reason="content-drift")`
   - `redirect` → `attach_evidence(source={url: <final>, retrieved_at: now})`
   - `ok` / `paywalled` / `blocked` / `quota` → no action
3. Write `workspace/refresh/report.json` and stop.
