---
name: recognizer
kind: service
---

# Recognizer

### Description

For each high-volume host in `recognition_gaps` (i.e. real merchants
the curated indexes missed — combined 30d volume above the configured
floor, `is_recognized = false`), dig deeper to either confirm a real
operator (set `is_recognized = true` + an evidenced `display_name`)
or leave the host as-is. This is the riskiest slice — flipping
`is_recognized` admits a host into the launchable showcase set, so
the bar is high.

### Shape

- `self`: free home-page fetch → optional `exa_search` (category=
  `company`) → optional `twitter_search` for the operator's handle →
  optional `firecrawl_scrape` for an about / team / press page. Emit
  recognition proposals with sources.
- `prohibited`: any direct frame mutation; more than 3 paid calls per
  host (hard cap, regardless of budget)

### Requires

- `hosts`: from `inventory.recognition_gaps`
- `budget_usd`: shared budget; recognizer is allowed a larger portion
  than namer because each host can warrant multiple sources
- `frame`: path to the frame directory

### Ensures

- `proposals`: `workspace/recognizer/proposals.json`, one entry per
  investigated host: `{ host, entity_id, outcome, display_name?, description?, is_recognized, sources[], notes? }`
- `outcome` is one of:
  - `"confirmed"` — at least 2 independent sources name the operator
  - `"unconfirmed"` — investigation done, evidence insufficient; no
    facts to write, but the run is recorded so the next tick can
    skip this host
  - `"infra-misclassified"` — evidence shows this is actually
    infrastructure (CDN, SaaS sub-host) and should be flagged
    `is_infra = true` — recognizer does NOT write `is_infra` directly
    (it is owned by the deterministic phase) but surfaces in `notes`
    so the operator can update `scripts/host.ts` infra detection
- `is_recognized = true` is proposed ONLY when `outcome = "confirmed"`
- every `sources` entry has `{ url, retrieved_at, kind, snippet }`
  where `kind` is `home` | `about` | `social` | `press`

### Errors

- `RecognizerBudgetGuard`: recognizer would exceed its allocated
  portion of `budget_usd` — stop paid escalations; emit `outcome =
  "unconfirmed"` for remaining hosts with `notes: "budget-exhausted"`

### Invariants

- NEVER propose `is_recognized = true` without at least 2 independent
  sources (the home page + ONE of: official social handle, press
  coverage, about / team page on a separate domain)
- the home page alone is NEVER sufficient — anyone can stand up a
  marketing page; the second source must be off-host
- when the operator's identity is genuinely unclear (no team page, no
  social, just a checkout form), default to `outcome = "unconfirmed"`
- when sources name a different parent company than the host suggests
  (e.g. `api.example.com` is operated by BigCorp), record the
  parent in `notes` but do NOT change `display_name` to the parent —
  the host belongs to this entity, name it after the host's brand

### Strategies

- begin every investigation with the home page; if it has a team /
  about link, follow that first (free)
- when the home page mentions the operator's X / Twitter handle, use
  `twitter_search` with that handle to verify recent activity (≥ 1
  post in last 90 days, ≥ 100 followers — low bars, but they filter
  out abandoned brands)
- when no social handle is given, `exa_search` for
  `"<display_name candidate>" site:<host>` to find an internal about
  page; if that fails, search broadly for the candidate name to find
  external press
- when high volume comes mostly from Tempo (mppscan) and the host has
  no x402 presence, lean on the operator's X presence as the second
  source — Tempo merchants tend to be more X-native
- when the host turns out to be a generic SaaS instance (e.g. a
  Vercel deployment URL, an `api.cloudflare.com` subroute), set
  `outcome = "infra-misclassified"` and let the operator update the
  scrapers' infra detection rules

### Tools

- `mcp:pay`: required — `pay_tool`, `wallet_status`
- `cli:curl`: required for free fetches
