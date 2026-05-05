# layoffs-2026

A live dataset of notable workforce reductions announced during 2026.

## Scope

**In scope**
- Layoffs announced in 2026 (calendar year), or earlier announcements with execution dates in 2026
- Companies with ≥ 50 affected employees OR ≥ 5% of workforce OR a public/notable employer (any size)
- Global coverage; US/EU/UK/APAC tagged via `region`
- Both official announcements and credible third-party reporting (with the official source preferred when both exist)

**Out of scope**
- Pre-2026 layoffs (use a separate frame if needed)
- Individual firings, performance-management terminations of single people
- Speculative "X is preparing layoffs" rumors without a confirmed announcement
- Re-org announcements with no headcount reduction

## Sources

The maintenance loop is multi-source by design — provenance variety is the point.

| Source                  | Tool                                                | Used for                             |
|-------------------------|-----------------------------------------------------|--------------------------------------|
| Google News             | `stableenrich /api/serper/news`                     | Discovery of new announcements       |
| Exa neural web search   | `stableenrich /api/exa/search`                      | Semantic discovery + freshness checks|
| Reddit (r/layoffs etc.) | `stableenrich /api/reddit/search`                   | Employee-side confirmation, mood     |
| X / Twitter             | `twit.sh /tweets/search`                            | Official CEO/company announcements   |
| Firecrawl scrape        | `stableenrich /api/firecrawl/scrape`                | Pulling full text from press release |
| SEC EDGAR / WARN sites  | direct HTTP fetch (free)                            | Authoritative filings (8-K, WARN)    |

## Entity ID convention

`<company-slug>-<YYYY-MM-DD>` — e.g. `meta-2026-01-22`. If a company announces multiple distinct rounds in the same year, each gets its own entity by date. Slugify lowercase, hyphenated.

## Authoritative source rule

When both an official statement (company blog, SEC filing, CEO post) and third-party reporting exist for the same fact, the official source wins for `layoff_count`, `layoff_percentage`, `reason_excerpt`, `affected_teams`. Third-party sources are kept on adjacent fields (`status`, `social_signal`).

## Tests

None yet. Future: a "no fact set without a source URL" assertion, plus a freshness check per entity (last refreshed within 7 days for `status`).
