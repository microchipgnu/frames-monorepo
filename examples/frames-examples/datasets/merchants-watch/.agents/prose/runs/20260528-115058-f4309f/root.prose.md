---
name: merchants-watch-curate
kind: system
---

# Curate

### Description

Agentic post-pass over the freshly-folded frame: fill display_name and
description for hosts the catalogs do not curate, infer category for
`category=other` hosts, dig into high-volume `is_recognized=false`
hosts to confirm or leave as-is, and discover net-new x402/MPP
merchants the scrapers have not yet observed. Every fact carries
`source.url`. The deterministic scrape phase owns identity and rail
truth; curate only fills naming, semantic, and recognition gaps.

### Services

- `inventory`
- `namer`
- `categorizer`
- `recognizer`
- `discoverer`
- `writer`
- `auditor`

### Requires

- `frame`: path to the frame directory
- `budget_usd`: total USDC ceiling across all `pay_tool` calls
- `naming_cap`: max naming_gaps to process per run
- `category_cap`: max category_gaps to process per run
- `recognition_cap`: max recognition_gaps to investigate per run
- `discovery_cap`: max net-new candidates per run
- `recognition_volume_floor_usd`: only investigate `is_recognized=false`
  hosts with combined 30d volume above this

### Ensures

- `report`: `workspace/curate/report.json` shaped as
  `{ added, named, categorized, recognized, deprecated, sources_attached, spent_usd, rejected_by_auditor, skipped_infra, skipped_mass_lister }`
- every newly-written fact carries `source.url` and `source.retrieved_at`
- every `display_name` written is NOT equal to the host (would be a
  no-op; auditor rejects)
- every `category` written is a valid `schema.yml` enum value AND has
  `category_source = "claude_inferred"`
- every `is_recognized = true` write has at least one corroborating
  source URL (company about page, official social handle, press
  coverage of the operator — never the host itself absent that)

### Errors

- `BudgetExceeded`: hard-stopped because `spent_usd` would cross
  `budget_usd`
- `WalletNotReady`: `mcp__pay__wallet_status` reports an unconfigured
  or unfunded wallet — abort before any paid call
- `NoCatalogTool`: every locked tool failed to resolve from `tools.lock`

### Invariants

- total `pay_tool` USDC ≤ `budget_usd` across the run (hard stop)
- never `set_fact` without a `source` in the same call
- never call `remove_entity`
- never write deterministic fields (see parent system's invariant list):
  `host`, `networks_accepted`, `on_*`, `bazaar_resource_count`,
  `tempo_*`, `volume_*`, `tx_count_*`, `probe_*`, `advertises_*`,
  `is_active_14d`, `is_mass_lister`, `is_infra`
- skip every host where `is_infra = true` (AWS Lambda, Vercel, Workers,
  …) — they are auto-generated infrastructure, not merchants worth
  enriching
- skip every host where `is_mass_lister = true`
  (`bazaar_resource_count > 500` — orbisapi, lowpaymentfee, …) — these
  are not really merchants, they are bazaar-flooding listers
- the auditor's read of a cited URL is canonical — when it disagrees
  with the writer's claim, the auditor wins (fact deprecated)
- never invent fields not in `schema.yml`
- never speculate `is_recognized = true` — leave it false if no public
  source confirms a real operator

### Strategies

- always try free `web_fetch` against the host's home page first; only
  escalate to paid `exa_search` / `firecrawl_scrape` / `twitter_search`
  when the home page parse is empty / 403 / off-topic
- when a host's home page is single-page-app heavy and `web_fetch` gets
  no useful text, prefer `firecrawl_scrape` (JS rendering) before
  `exa_search` — cheaper at $0.0126 vs the chained-query cost of
  semantic search
- when half the budget is spent and the discoverer slice is still empty,
  drop discovery and finish naming + categorization — the existing
  catalog is the priority over discovering new merchants
- when the auditor rejects > 25% of new facts, return a stop-signal so
  the operator pauses curate for a human review — usually means one of
  the paid tools is returning hallucinated content
- recognition is the riskiest slice (it changes `is_recognized` which
  affects the launchable showcase set). When evidence is ambiguous,
  the recognizer must leave it false

### Execution

```prose
let queues = call inventory
  frame: frame
  naming_cap: naming_cap
  category_cap: category_cap
  recognition_cap: recognition_cap
  recognition_volume_floor_usd: recognition_volume_floor_usd

let name_proposals = call namer
  hosts: queues.naming_gaps
  budget_usd: budget_usd
  frame: frame
in parallel with
let category_proposals = call categorizer
  hosts: queues.category_gaps
  budget_usd: budget_usd
  frame: frame
in parallel with
let recognition_proposals = call recognizer
  hosts: queues.recognition_gaps
  budget_usd: budget_usd
  frame: frame
in parallel with
let new_candidates = call discoverer
  budget_usd: budget_usd
  discovery_cap: discovery_cap
  frame: frame

let writes_applied = call writer
  name_proposals: name_proposals
  category_proposals: category_proposals
  recognition_proposals: recognition_proposals
  new_candidates: new_candidates
  frame: frame

return call auditor
  writes_applied: writes_applied
  frame: frame
```

### Tools

- `mcp:pay`: required — `wallet_status`, `list_tools`, `pay_tool`
- `mcp:frame-merchants-watch`: required — read + write
- `cli:curl`: required for free home-page fetches (web_fetch fallback)

### Runtime

- `persist`: project
