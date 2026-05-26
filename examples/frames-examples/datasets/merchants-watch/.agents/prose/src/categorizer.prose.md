---
name: categorizer
kind: service
---

# Categorizer

### Description

For each host in `category_gaps`, propose a `category` from the
`schema.yml` enum backed by an evidence URL. Free-first: read the
home page meta + hero. Escalate to one paid `exa_search` or
`firecrawl_scrape` per host only when the free read leaves the
category genuinely ambiguous (multi-vertical SaaS, redirected
landing pages, etc.).

### Shape

- `self`: free `curl` against `https://<host>`; optional one paid
  tool call per host; emit proposals
- `prohibited`: any direct frame mutation; more than ONE paid call
  per host; proposing a category not in the schema enum

### Requires

- `hosts`: from `inventory.category_gaps`
- `budget_usd`: shared budget; categorizer consumes a portion
- `frame`: path to the frame directory (for `schema.yml`)

### Ensures

- `proposals`: `workspace/categorizer/proposals.json`, one entry per
  host: `{ host, entity_id, category, category_source, source_url, retrieved_at, confidence, evidence_phrase }`
- every proposal has `category_source = "claude_inferred"`
- every `category` value is in the schema enum: `ai_ml`, `data`,
  `search`, `messaging`, `maps`, `translation`, `security`,
  `shopping`, `media`, `finance`, `cloud`, `storage`, `devtools`,
  `compute`, `other`
- every proposal carries an `evidence_phrase` — a verbatim 1-line
  snippet from the source page that justifies the category

### Errors

- `CategorizerBudgetGuard`: categorizer would exceed its allocated
  portion of `budget_usd` — stop paid escalations

### Invariants

- never propose `category = "other"` — that is what we are TRYING to
  fix; omit the host instead and let the next tick try again
- never propose a category that is not in the schema enum (no
  inventing new buckets)
- the source URL must be the page where `evidence_phrase` actually
  appears verbatim — auditor will re-read

### Strategies

- canonical taxonomy heuristics (verbatim phrases on the home page):
  - "LLM" / "inference" / "embedding" / "agent" → `ai_ml`
  - "API" / "dataset" / "warehouse" / "ETL" → `data`
  - "search" / "retrieval" / "index" → `search`
  - "SMS" / "chat" / "messaging" / "notifications" → `messaging`
  - "maps" / "geocoding" / "routing" → `maps`
  - "translation" / "localization" → `translation`
  - "auth" / "fraud" / "abuse" / "captcha" → `security`
  - "checkout" / "merchant" / "ecommerce" / "products" → `shopping`
  - "video" / "image" / "audio" / "podcast" → `media`
  - "payments" / "wallet" / "ledger" / "billing" → `finance`
  - "compute" / "container" / "lambda" / "function" → `compute`
  - "S3" / "bucket" / "blob" / "object storage" → `storage`
  - "CI" / "deploy" / "build" / "package manager" → `devtools`
  - "CDN" / "edge" / "hosting" / "DNS" → `cloud`
- when the home page sells two clearly distinct verticals (e.g. an
  AI gateway that also does data warehousing), pick the one named
  first in the hero — the home page implicitly ranks them
- when the home page is paywalled / cookie-walled and free fetch
  yields nothing, escalate to ONE `firecrawl_scrape` (cheaper than
  exa_search at $0.0126); if firecrawl also fails, omit the host
- never escalate to `exa_search` for a host whose primary signal is
  obvious from a 200-byte snippet — that's wasted budget
- when the home page is genuinely off-topic to the merchant function
  (e.g. a marketing landing for a non-API product where the API is
  the actual service), use `exa_search` with `category=company` to
  find the docs / API page; categorize from there

### Tools

- `mcp:pay`: required when paid escalation is used — `pay_tool`,
  `wallet_status`
- `cli:curl`: required for free home-page fetches
