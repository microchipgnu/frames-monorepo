# crypto-ai-jobs

A live catalog of companies actively hiring at the intersection of crypto and AI.

## Scope

**In scope**
- Companies with at least one open role posted in the **last 90 days**
- Product or research spans **both** crypto/web3 and AI/ML (one side alone doesn't qualify)
- Global coverage; HQ tagged via `hq_country`
- Any size, any stage; including bootstrapped and public

**Out of scope**
- Companies whose only crypto/AI link is a marketing buzzword (e.g. a generic SaaS that mentions "AI" on its homepage but ships no AI product, or a defi protocol that lists "GPT" as a roadmap item)
- Crypto-only companies with no AI angle (track in a `crypto-companies` frame instead)
- AI-only companies with no crypto angle (track in `ai-models` or similar)
- Companies that have not posted a role in the last 90 days, even if they previously hired in this space
- Stealth or "in private beta" companies with no public hiring signal

## Hiring signal

A company is considered "currently hiring" if any of these resolves to a role posted within 90 days:

| Surface | What we look for |
|---|---|
| Company careers page | Date on a listing, or "Posted X days ago" pill |
| Greenhouse / Ashby / Lever / Workable / Workday | API or board page with `posted_at` |
| LinkedIn Jobs | Posted-date filter ≤ 90 days |
| `wellfound.com` (formerly AngelList) | Posted-date filter ≤ 90 days |
| Cryptocurrency-jobs aggregators (web3.career, cryptocurrencyjobs.co) | Posted date |

If the careers page exists but no posted-date is exposed, treat as `status: unknown` and don't claim hiring.

## Sources

| Source | Used for |
|---|---|
| Web search (Exa / WebSearch) | Discovery — "AI crypto startup hiring", "x402 jobs", "agent payments engineer" |
| Greenhouse / Ashby / Lever / Workable APIs (free) | Per-company role counts and `posted_at` |
| LinkedIn / wellfound.com | Cross-check + people side |
| Crypto-AI job aggregators | Discovery (web3.career, cryptocurrencyjobs.co, cryptojobslist.com) |
| GitHub | Verify the AI/crypto product is real (recent commits, repos) |
| Company homepage + blog | `crypto_focus`, `ai_focus`, `description` |

## Entity ID convention

`<company-slug>` — lowercase, hyphenated, derived from `name`. Example: `anthropic`, `worldcoin`, `bittensor`. If two companies collide on slug, suffix with HQ country: `acme-us`, `acme-de`.

One entity per company. Multiple hiring rounds across time are reflected by updating `last_job_posted_at` and `open_roles_count`, not by creating new entities.

## Authoritative source rule

When both an ATS API (Greenhouse/Ashby/Lever) and a third-party aggregator
list the same company, the **ATS** wins for `careers_url`,
`last_job_posted_at`, `open_roles_count`, and `hiring_platform`.
Aggregators are kept on adjacent fields (`social_signal`).

For `crypto_focus` and `ai_focus`, the **company's own** homepage or blog
wins over reporting.

## Tests

None yet. Future:
- Every entity must have at least one fact on `careers_url` OR `hiring_platform` set in the last 7 days, else status auto-flips to `unknown`.
- `last_job_posted_at` within 90 days of latest tick for `status: hiring`.
