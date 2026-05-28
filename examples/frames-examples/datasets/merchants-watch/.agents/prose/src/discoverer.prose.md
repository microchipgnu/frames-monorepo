---
name: discoverer
kind: service
---

# Discoverer

### Description

Hunt for x402 / MPP merchants the deterministic scrapers have not yet
observed. Sources: news (`serper_news`), social (`twitter_search`),
and semantic web (`exa_search`). Each candidate host is verified with
a free `web_fetch` + 402 probe before being proposed as a new entity.
Capped tight: discovery is bonus signal, not the main job — the
scrape phase already runs every tick against the bazaar, agentic.market,
pay.sh, and mppscan.

### Shape

- `self`: paid search queries → free probe of each candidate host →
  emit new-entity candidates
- `prohibited`: any frame mutation (writer applies the candidates);
  proposing candidates whose host already exists in
  `inventory.existing_hosts`; proposing without a 402 probe

### Requires

- `budget_usd`: shared budget; discoverer's portion is the smallest
  of the curate services (~$0.15 default)
- `discovery_cap`: max candidates emitted per run
- `frame`: path to the frame directory (for `inventory.existing_hosts`)

### Ensures

- `candidates`: `workspace/discoverer/candidates.json`, capped at
  `discovery_cap`, each entry
  `{ host, entity_id, display_name?, description?, category?, probe: { advertises_x402, advertises_mpp, advertised_methods, advertised_networks, probe_endpoint }, sources[], notes? }`
- every candidate has at least one probe result attached — either
  `probe_status = "ok"` (the host actually responds with 402) OR an
  explicit `notes` explaining why the operator is credible despite no
  probe success (rarely valid — most candidates without a successful
  probe should be dropped, not noted)
- every candidate has `host NOT IN inventory.existing_hosts`
- every candidate has `sources[]` with ≥ 1 entry — usually the
  paid search hit that surfaced it, plus the host's home page

### Errors

- `DiscovererBudgetGuard`: discoverer would exceed its allocated
  portion of `budget_usd` — stop querying; emit whatever candidates
  already verified
- `AllQueriesEmpty`: every search returned zero novel hosts (all hits
  matched `existing_hosts`) — emit empty `candidates[]`, log normally

### Invariants

- never propose a candidate already in the frame — dedup against
  `existing_hosts` BEFORE running the 402 probe (saves cost on dead
  candidates)
- never propose a host whose probe returns `non-402` AND has no
  off-host operator evidence — most likely a misfire from search
- never propose a host that matches the `is_infra` heuristics in
  `scripts/host.ts` (the bazaar already filters these; the discoverer
  should mirror that filter)
- candidates land with NO deterministic facts (`on_bazaar`,
  `networks_accepted`, `bazaar_resource_count`, …) — the next scrape
  phase will fill those when the catalogs index the host. Discoverer
  only writes naming + recognition fields plus the probe-derived
  `advertises_*` and `probe_*`.

### Strategies

- query palette:
  - `serper_news`: `"x402 protocol merchant launch"`,
    `"MPP payment API" <last-7-days>`,
    `"accepting USDC" "API" <last-14-days>`
  - `exa_search` (category=`company`): `"x402 API merchant"`,
    `"agentic payment endpoint"`
  - `twitter_search` (queryType=`Latest`): `"just shipped" x402`,
    `"my API now accepts" USDC`
- dedup heuristic: extract every `https?://[host]` reference from
  search hits, canonicalize via `scripts/host.ts:canonicalHost`,
  drop those already in `existing_hosts`, then probe the rest
- 402 probe (two-step — a bare guess never elicits a 402):
  1. GET `https://<host>/.well-known/x402` (fall back to `/llms.txt`).
     This discovery doc is served on **GET** (200) and lists the
     host's real paid resource endpoint(s) + accepted rails. x402
     resources do NOT 402 on GET, and POSTing the doc path returns
     404/405 — so GET is for discovery only, never for the challenge.
  2. **POST** `{}` to the resource endpoint named in the discovery doc
     (or the search-hit URL if it is already API-shaped). The 402
     challenge only comes back on POST to the actual resource. If the
     response is 402 with an x402 `accepts[]` envelope or a
     `WWW-Authenticate: Payment` header, capture `advertises_x402` /
     `advertises_mpp` / methods / networks.
  Guessing generic paths (`/api/x402`, `/x402`, `/api/pay`) with
  either method is a dead end — they 404/405 (confirmed in run
  20260528-115058: revettr.com 404'd every guessed POST, then a GET
  on `/.well-known/x402` surfaced the real endpoint that POST-402'd).
  The probe-402 logic in `scripts/probe-402.ts` is the reference for
  parsing the 402 (it POSTs the bazaar's already-known resource URLs);
  the discoverer adds the `.well-known/x402` GET-discovery step because,
  unlike the scrape phase, it has no pre-known endpoint path.
- when the discoverer would emit < 3 candidates, that is fine —
  this slice is incremental signal, not a quota

### Tools

- `mcp:pay`: required — `pay_tool`, `wallet_status`
- `cli:curl`: required for free probe + home-page fetches
