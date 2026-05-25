---
name: layoffs-verify
kind: program
---

Read-only health check for the `layoffs-2026` frame: re-fetch every cited
source URL and classify drift. No frame mutations, no paid tool calls.

### Requires

- `frame`: path to the frame directory (default: `.`)

### Ensures

- `report`: a JSON file at `workspace/verify/report.json` shaped as
  `{ ok_count, redirect_count, content_changed_count, dead_count, quota_count, paywalled_count, blocked_count, classified[] }`
- `classified[]` contains one entry per fact with `{ fact_id, entity_id, url, status, http_code, redirect_to?, notes? }`
  where `status ∈ { ok, redirect, content_changed, dead, quota, paywalled, blocked }`
- no events appended to `events.ndjson`
- no calls to `pay_tool`

### Invariants

- read-only: never call `set_fact`, `add_entity*`, `deprecate_fact`, `attach_evidence`, or `remove_entity`
- every fact source URL is fetched exactly once; no source is skipped
- never edit files inside the frame directory by hand — read only
- never invoke `mcp__pay__pay_tool`

### Strategies

- when a URL redirects, follow up to 3 hops and record the final URL
- when a URL returns 5xx, classify as `dead` only after one retry with 2-second backoff
- when a URL returns 200 but the page no longer contains the cited excerpt, classify as `content_changed`. Use distinctive-token matching (proper nouns, numbers, long rare words) with a ≥70% retention threshold — strict substring matching produces false positives against JS-rendered pages.
- when a URL returns 401/402/403 from a **known paywall host** (`wsj.com`, `ft.com`, `bloomberg.com`, `nytimes.com`, `bizjournals.com`, `economist.com`, `theinformation.com`, `nikkei.com`), classify as `paywalled` rather than `dead` — these sources legitimately exist but require a subscription to re-verify
- when a URL returns 403 or 406 from a **non-paywall host** (CDN bot-protection on sites like `stocktitan.net`, `newsweek.com`, `fastcompany.com`, `geekwire.com`, `fiercebiotech.com`, `oregonlive.com`, `cleveland.com`, `al.com`, `massdevice.com`, `time.com`, `ndtvprofit.com`, `financialexpress.com`, `manufacturingdive.com`, `businessinsider.com`), classify as `blocked` — the page exists for a browser, just not for plain HTTP. **Never collapse `blocked` into `dead`** — they have opposite refresh semantics (blocked → leave alone; dead → deprecate)
- when a URL returns 429, classify as `quota` and skip — do not retry in the same run
- when the cited domain is SEC EDGAR (`*.sec.gov`), the WARN database, or a state labor portal, expect the URL to be stable; treat any non-200 as a real signal worth surfacing (the bot-block exception does NOT apply to authoritative government sources)
- a `400` or `404` is `dead` regardless of host — those are real "not found", not bot-protection

### Execution

1. Use `mcp__frame-layoffs-2026__query` (mode=`sql`) to enumerate every distinct
   `(fact_id, entity_id, source.url, source.excerpt?)` triple across the frame.
   If the frame MCP server is unavailable, fall back to reading
   `events.ndjson` directly with `jq` — this program is read-only, so the
   "all writes go through MCP" invariant is vacuous here. Surface the
   fallback in the run trace.
2. For each unique URL, fetch it (HEAD then GET if needed) and classify into
   one of: `ok` | `redirect` | `content_changed` | `dead` | `quota` |
   `paywalled` | `blocked`. Fan out the per-URL status across every fact
   that cites it.
3. Write `workspace/verify/report.json` and surface the counts in the run trace.
