# layoffs-2026 — daily tick

You are maintaining a live dataset of notable workforce reductions announced
in 2026. Schema and scope are in `datasets/layoffs-2026/schema.yml` and
`datasets/layoffs-2026/README.md`. Read both before doing anything.

You have these tools wired in:
- `frame-layoffs-2026` — write entities and facts to the dataset
- The frames registry — paid x402 access to:
  - Google News via Serper (`stableenrich /api/serper/news`) — discovery
  - Exa neural search (`stableenrich /api/exa/search`) — semantic + freshness
  - Reddit search (`stableenrich /api/reddit/search`) — employee confirmation
  - Twitter/X search (`twit.sh /tweets/search`) — official CEO/company posts
  - Firecrawl scrape (`stableenrich /api/firecrawl/scrape`) — full page text
- Free HTTP for SEC EDGAR (`https://www.sec.gov/cgi-bin/browse-edgar`) and
  state WARN notice databases

## Loop

1. **Read state.** Use `mcp__frame-layoffs-2026__query` mode=sql:
   `SELECT entity_id, MAX(date_announced) AS d FROM rows GROUP BY entity_id`
   to inventory existing entities and their announcement dates.

2. **Discover new announcements.** Run, in parallel:
   - Serper News: `q="layoffs 2026"`, `num=20`, `gl=us`. Then a second pass
     with `q="company layoffs <previous-week-date>"` to catch what aged out.
   - Exa neural: `query="company announces layoffs in 2026"`,
     `numResults=15`, `startPublishedDate=<7-days-ago>`.
   - Reddit (via stableenrich): `query="laid off today"`,
     `sort="new"`, `timeframe="week"`. Filter to posts from r/layoffs,
     r/cscareerquestions, r/recruitinghell, r/jobs, r/sales.

   Deduplicate by company name. Cap at **20 new entity candidates per run**
   to bound cost.

3. **For each new candidate:**

   a. **Verify with a primary source.** Call `firecrawl/scrape` on the most
      authoritative URL (company blog > SEC 8-K > CEO X post > tier-1 news >
      tier-2 news). If the page doesn't actually substantiate the layoff,
      drop the candidate.

   b. **Cross-check on X.** `twit.sh /tweets/search`:
      `from=<company_handle>` OR `mentioning=<company>`, `since=<announcement-date>`.
      Find any official statement; capture as `official_statement_url`.

   c. **Pull headcount.** From the verified source, extract `layoff_count`,
      `layoff_percentage`, `total_workforce_before`. If only one of count/%
      is given and you know workforce, do NOT compute the other — store
      what's stated, omit what isn't.

   d. **Classify** `sector`, `region`, `reason_stated` from the schema enums.
      If unsure between two reasons, pick the one explicitly named by the
      company. `other` is allowed.

   e. **Write.** `add_entity_with_facts` with:
      - `entity_id`: `<company-slug>-<YYYY-MM-DD>`
      - one fact per known field, each with its own `source.url`
      - `status` defaults to `announced`

4. **Refresh existing rows.** For entities where `status = announced` and
   `date_announced` is older than 14 days, re-check the official source +
   X for `executed` / `rescinded` updates. Use `set_fact` on `status` only
   if the value would change.

5. **Stop.** Print summary: added, refreshed, dropped (with reason),
   sector histogram, region histogram, total entities now in dataset.

## Constraints

- Every fact MUST have a `source.url`. No exceptions.
- Prefer official sources over reporting. Prefer the original report over
  aggregator rewrites. Never cite Wikipedia, layoffs.fyi summaries, or
  AI-generated news roundups.
- For `layoff_count`: if sources conflict, store the official number AND
  set `status = disputed` with `reason_excerpt` quoting the conflict.
- For `reason_excerpt`: 1–3 sentences, verbatim from the source. Quote it.
  Do not paraphrase.
- ≤ 20 new entities per tick. ≤ 30 refreshes per tick. Stay under $1.50 of
  paid API spend per tick (track via response payment metadata).
- Skip entities where the company is not identifiable (e.g. "a major US
  retailer" with no name).

## Done when

- All discovery sources have been hit at least once.
- New candidates are verified-or-dropped (no half-states).
- Stale `announced` entities have been considered for refresh.
- Summary printed.
