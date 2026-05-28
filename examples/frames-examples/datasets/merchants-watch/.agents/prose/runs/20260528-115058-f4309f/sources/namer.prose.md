---
name: namer
kind: service
---

# Namer

### Description

For each host in `naming_gaps`, propose a `display_name` (and
`description` when available) backed by an evidence URL. Free-first:
fetch the host's home page and read its `<title>` / `og:site_name` /
hero copy. Only escalate to paid `exa_search` (category=`company`) or
`firecrawl_scrape` when the home page is empty / 403 / SPA-shell with
no static copy.

### Shape

- `self`: free `curl` against `https://<host>`; optional one paid
  tool call per host; emit proposals
- `prohibited`: any direct frame mutation (writer applies the
  proposals); more than ONE paid call per host

### Requires

- `hosts`: from `inventory.naming_gaps`
- `budget_usd`: shared budget; namer consumes a portion
- `frame`: path to the frame directory (for context)

### Ensures

- `proposals`: `workspace/namer/proposals.json`, one entry per host:
  `{ host, entity_id, display_name?, description?, source_url, retrieved_at, confidence, notes? }`
- every proposal carries a `source_url` that resolves to a page where
  the proposed name appears in plain text
- proposals with `confidence < 0.6` carry a `notes` field explaining
  the ambiguity — writer may still apply them but auditor will check
  harder

### Errors

- `NamerBudgetGuard`: namer would exceed its allocated portion of
  `budget_usd` — stop paid escalations; remaining hosts are emitted
  with no proposal (writer skips them)

### Invariants

- never propose `display_name` equal to the host (e.g. `exa.ai` for
  exa.ai) — that is a no-op; the merge.ts host-derived fallback
  already covers it
- never propose a name from a page whose URL does not contain that
  name in text the auditor can verify
- the source URL MUST be the page the name was extracted from, not
  the host's homepage by default (when escalating to firecrawl, save
  the firecrawl-rendered URL)

### Strategies

- prefer `<title>` minus generic suffixes (" — Home", " | Welcome",
  etc.); fall back to `og:site_name`; fall back to the first H1
- when the home page redirects to a SaaS-marketing landing whose title
  is "Sign in" / "Login", treat as insufficient and escalate to
  `exa_search` with `category=company` and query `<host>`
- when `exa_search` returns multiple companies for an ambiguous host
  (e.g. shared brand names), drop the proposal — better to leave
  display_name as host than mislabel
- for hosts whose home page is in a non-English language only,
  preserve the original `<title>` verbatim (do not auto-translate);
  the description can carry an English summary if the page provides
  one
- description should be 1–2 sentences, drawn verbatim from the page's
  meta description or hero copy; do NOT paraphrase

### Tools

- `mcp:pay`: required when paid escalation is used — `pay_tool`,
  `wallet_status`
- `cli:curl`: required for free home-page fetches
