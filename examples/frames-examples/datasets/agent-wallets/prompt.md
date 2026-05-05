# agent-wallets — daily tick

You maintain a catalog of agent wallets, registries, and payment
protocols, plus the tool/service endpoints each one exposes. Schema and
scope in `datasets/agent-wallets/schema.yml` and
`datasets/agent-wallets/README.md`.

Tools:
- `frame-agent-wallets` — write to the dataset
- Frames registry — Exa for discovery, GitHub for repo metadata,
  vendor docs for endpoint lists

## Loop

1. **Read state.** Query
   `frame-agent-wallets_query` mode=sql:
   `SELECT entity_id, name, status, last_verified_at FROM rows
    ORDER BY COALESCE(last_verified_at, '1970-01-01') ASC`

2. **Cold-start discovery (only if dataset is empty).** Sweep the
   discovery surfaces in the next subsection. Admit up to **5 entities**
   in this single first run, each with a strong primary source. For
   each admitted entity, set fields per step 4 and stop. Do not run
   step 3 on a cold start.

3. **Discover (steady state).** Sweep the discovery surfaces below for
   new wallets, registries, or payment protocols not already in the
   dataset. Bar for admission:
   - **Primary source must be vendor-controlled**: vendor blog post,
     GitHub release, official docs page, or filed announcement.
     Directory pages and Twitter posts are *discovery aids only* — they
     point you at candidates, but the candidate must have a real vendor
     source before admission.
   - The product must be **agent-targeted** — generic crypto wallets
     and stablecoin issuers don't qualify unless they ship an
     agent-specific surface.
   - **At most 2 new entities admitted per run.** Strongest first.
   `entity_id` format: `<vendor-slug>-<product-slug>`, collapsing when
   vendor and product are the same (e.g. `crossmint`, `skyfire`,
   `coinbase-x402`, `frames-engineering-agentwallet`).

   **Discovery surfaces** (use ALL of them — directories first, since
   they have the highest candidate density):

   a. **Curated directories & ecosystem pages** — fetch via Exa or
      direct HTTP, extract the list of named products, then go
      validate each one against a vendor source:
      - `https://agentpaymentsstack.com/`
      - `https://x402.org/ecosystem`
      - `https://github.com/topics/x402`
      - `https://github.com/topics/agent-wallet`
      - `https://github.com/topics/ai-agents` (filter for payment-
        adjacent repos)
      - Search for `awesome-x402`, `awesome-agent-payments`,
        `awesome-agent-wallets` GitHub READMEs

   b. **Twitter / X via the registry's Twitter service**
      (`https://registry.frames.ag/api/service/twitter/api/search-tweets`,
      paid via x402 / agentwallet). Search the past 30 days for:
      - `"x402" launch since:<today-30d>`
      - `"agent wallet" announcing since:<today-30d>`
      - `"agent payments" shipping OR launching since:<today-30d>`
      - `"agent commerce" since:<today-30d>`
      Filter to *verified founders or vendor accounts* announcing
      something material (no opinion threads, no analyst hot-takes).
      Each tweet must link to a vendor blog/docs that becomes the
      primary source.

   c. **Exa keyword sweeps** (past 30 days):
      - `"agent wallet" announcement`
      - `"x402" registry`
      - `"agent commerce" payment`
      - `"machine payments" wallet`
      - `agentwallet`, `agent registry`, `payments for agents`

   d. **Cold-start anchors** (only on first run, in addition to the
      above): explicitly check **agentwallet** (frames-engineering),
      **Frames Registry** (`registry.frames.ag`), and **x402**
      (Coinbase) regardless of whether they surface in the sweeps.

4. **Refresh stalest 3.** Pick the 3 entities with the oldest
   `last_verified_at`. For each:
   - **Liveness**: fetch `api_base_url` via Exa. If it 404s or
     redirects to a generic landing page, search for a replacement
     URL. If no replacement and no announcement in 12+ months,
     `set_fact status=dead`.
   - **Services**: hit the registry endpoint (or scrape docs) and
     update the `services` field. Format each line as
     `<name> — <endpoint> — <one-sentence>`. Keep top **10**
     most-recently-confirmed; trim the rest (full history is in
     `events.ndjson`).
   - **Announcements**: search the vendor's blog/changelog/GitHub
     releases for material updates since `last_verified_at`. If
     anything notable, update `announcement_url` to the newest entry.
   - **Status**: move to `beta` → `active`, or to `deprecated` /
     `dead` only with a vendor statement or 12-month silence + dead
     URL. Status is sticky-forward.
   - **Always** `set_fact last_verified_at` to now (ISO 8601).

5. **Stop.** Print: cold-start (y/n), admitted count, refreshed count,
   status changes, dead URLs found.

## Constraints

- Every fact must cite a vendor-controlled source (their blog, GitHub
  release, official docs page, regulatory filing). Directories and
  tweets are discovery aids, never fact sources — if you find a
  candidate on agentpaymentsstack.com but can't reach a vendor page,
  do not admit it.
- Never invent endpoints. If a service's URL isn't on the vendor's
  docs page, omit it.
- `services` field stores the **public** registry — paid endpoints
  count, but private/customer-only ones don't.
- ≤ 2 admissions + ≤ 3 refreshes per run. Cold-start may admit 5.
- `name` and `entity_id` are immutable once admitted. Vendor renames
  are PR territory.

## Done when

- Cold-start ran (if applicable), OR ≤ 2 new admitted + ≤ 3 refreshed.
- Summary printed.
