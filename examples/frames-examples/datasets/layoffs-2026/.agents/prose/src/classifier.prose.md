---
name: classifier
kind: service
---

# Classifier

### Description

Enumerate every cited source URL in the frame, fetch each, and classify the
result. Shared by `layoffs-refresh` (which acts on the classification) and
read-only callers like `layoffs-verify` (which only reports).

### Shape

- `self`: enumerate facts, fetch URLs, classify each
- `prohibited`: any frame mutation, any `pay_tool` call

### Requires

- `frame`: path to the frame directory

### Ensures

- `classified`: array of `{ fact_id, entity_id, url, status, http_code, redirect_to?, notes? }`
  where `status ∈ { ok, redirect, content_changed, dead, quota, paywalled, blocked }`
- every distinct fact source URL is fetched exactly once

### Errors

- `frame-unavailable`: `mcp__frame-layoffs-2026__query` failed AND
  `events.ndjson` could not be read either

### Invariants

- read-only — no `set_fact`, no `add_entity*`, no `deprecate_fact`, no
  `attach_evidence`, no `remove_entity`
- never invoke `mcp__pay__pay_tool`

### Strategies

- when a URL redirects, follow up to 3 hops and record the final URL
- when a URL returns 5xx, classify as `dead` only after one retry with
  2-second backoff
- when a URL returns 200 but the page no longer contains the cited excerpt,
  classify as `content_changed`. Use distinctive-token matching with a ≥70%
  retention threshold — strict substring matching produces false positives
  against JS-rendered pages.
- when a URL returns 401/402/403 from a known paywall host (`wsj.com`,
  `ft.com`, `bloomberg.com`, `nytimes.com`, `bizjournals.com`, `economist.com`,
  `theinformation.com`, `nikkei.com`), classify as `paywalled`
- when a URL returns 403 or 406 from a non-paywall host (CDN bot-protection
  on sites like `stocktitan.net`, `newsweek.com`, `fastcompany.com`,
  `geekwire.com`, `fiercebiotech.com`, `oregonlive.com`, `cleveland.com`,
  `al.com`, `massdevice.com`, `time.com`, `ndtvprofit.com`,
  `financialexpress.com`, `manufacturingdive.com`, `businessinsider.com`),
  classify as `blocked`. **Never collapse `blocked` into `dead`** — opposite
  refresh semantics.
- when a URL returns 429, classify as `quota` and skip — no same-run retry
- when the cited domain is SEC EDGAR (`*.sec.gov`), the WARN database, or a
  state labor portal, the bot-block exception does NOT apply — treat any
  non-200 as real signal
- `400` and `404` are `dead` regardless of host
- if the frame MCP is unavailable, fall back to reading `events.ndjson`
  directly with `jq`; surface the fallback in the run trace

### Tools

- `mcp:frame-layoffs-2026`: optional — falls back to `events.ndjson`
- `cli:jq`: needed for the fallback path

### Runtime

- `persist`: project
