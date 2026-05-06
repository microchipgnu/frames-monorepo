# crypto-ai-jobs — daily tick

You maintain a live catalog of companies actively hiring at the
intersection of crypto and AI. Schema and scope in
`datasets/crypto-ai-jobs/schema.yml` and
`datasets/crypto-ai-jobs/README.md`. Read both before doing anything.

You have these tools wired in:
- `frame-crypto-ai-jobs` — write entities and facts to the dataset
- The frames registry — paid x402 access to:
  - Exa neural search (`stableenrich /api/exa/search`) — discovery
  - Google search (`stableenrich /api/serper/search`) — discovery
  - Firecrawl scrape (`stableenrich /api/firecrawl/scrape`) — careers pages
  - GitHub API (free) — verify product activity
- Free HTTP for Greenhouse, Ashby, Lever, Workable boards
  (e.g. `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs`,
  `https://api.ashbyhq.com/posting-api/job-board/<slug>`,
  `https://api.lever.co/v0/postings/<slug>`).

## Loop

1. **Read state.** Use `mcp__frame-crypto-ai-jobs__query` mode=sql:
   `SELECT entity_id, MAX(last_job_posted_at) AS d, MAX(open_roles_count) AS n
    FROM rows GROUP BY entity_id`
   to inventory existing companies, their most recent posting date, and
   open role count.

2. **Discover new companies.** Run, in parallel:
   - Exa neural: `query="AI crypto startup hiring engineers 2026"`,
     `numResults=15`, `startPublishedDate=<14-days-ago>`. Then a second
     pass: `query="x402 OR 'agent payments' OR 'onchain AI' hiring"`.
   - Serper search: `q="site:greenhouse.io AI crypto"`, `q="site:ashbyhq.com agent crypto"`,
     `q="site:jobs.lever.co web3 AI"`. Tier-1 ATS host filters surface
     real boards directly.
   - Crypto-AI job boards: `firecrawl/scrape` on
     `https://web3.career/ai-jobs`, `https://cryptocurrencyjobs.co/ai/`,
     `https://cryptojobslist.com/ai-machine-learning-jobs` — extract
     company names + careers URLs.

   Deduplicate by company slug. Cap at **15 new entity candidates per
   run** to bound cost.

3. **For each new candidate:**

   a. **Confirm it spans both sides.** Fetch the company homepage with
      `firecrawl/scrape`. Confirm crypto/web3 (tokens, smart contracts,
      onchain, wallet, payments rails) AND AI/ML (models, agents,
      inference, training, ML infra) are both load-bearing parts of the
      product — not buzzword decoration. If only one side is real, drop
      the candidate.

   b. **Resolve the careers source.** Try in order:
      `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs` →
      `https://api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true` →
      `https://api.lever.co/v0/postings/<slug>?mode=json` →
      Workable / Workday board page → company `/careers` HTML. Capture
      `careers_url` (the public page), `hiring_platform` (the resolved
      ATS), `open_roles_count` (count of open roles), and
      `last_job_posted_at` (max `updated_at` / `posted_at` across roles).
      If no role's `posted_at` is within 90 days, drop the candidate.

   c. **Capture sample roles.** From the ATS response, take up to 3 of
      the most recent role titles into `open_roles_sample` (single
      string, ` | `-separated). This is the human-readable signal that
      the company is real and the roles are crypto+AI shaped.

   d. **Classify** `category`, `funding_stage`, `hq_country` from the
      company homepage / about page. Don't guess `funding_stage` — leave
      `unknown` if not stated in the last 12 months.

   e. **Write.** `add_entity_with_facts` with:
      - `entity_id`: `<company-slug>` (lowercase, hyphenated, from name)
      - one fact per known field, each with its own `source.url`
      - `status` defaults to `hiring`

4. **Refresh existing rows.** For every entity in state where
   `status = hiring` and last touched > 7 days ago:
   - Re-hit the ATS endpoint. `set_fact` on
     `open_roles_count`, `last_job_posted_at`, `open_roles_sample` only
     if the value would change.
   - If the latest `posted_at` across roles is now > 90 days old, flip
     `status` to `paused` and stop refreshing this entity until the next
     full tier pass.
   - If the ATS endpoint 404s or returns 0 roles, flip `status` to
     `unknown` and capture the failure mode in `social_signal`.

5. **Stop.** Print summary: added / refreshed / status-flipped / dropped
   (with reason), category histogram, hiring-platform histogram, total
   entities now in dataset.

## Constraints

- Every fact MUST have a `source.url`. No exceptions.
- Prefer the ATS API over the company's HTML careers page (more reliable
  `posted_at`). Prefer the company's own homepage over reporting for
  `crypto_focus` / `ai_focus`.
- A candidate is dropped — not stored as `unknown` — if the crypto+AI
  intersection isn't substantiated by the homepage. We don't keep
  speculative rows.
- ≤ 15 new entities per tick. ≤ 30 refreshes per tick.
- Entity IDs are stable: never re-slug an existing entity even if `name`
  is corrected — set the new name as a fact, leave the slug.
- Don't treat marketing buzzwords as evidence. "AI-powered DEX with no
  ML actually shipping" doesn't qualify.

## Done when

- All discovery sources have been hit at least once.
- New candidates are confirmed-and-written or dropped (no half-states).
- Stale `hiring` entities older than 7 days have been considered for
  refresh.
- Summary printed.
