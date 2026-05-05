# frames-cloud — Plan

GitHub-resolver runtime for [frame](https://github.com/microchipgnu) datasets. Point at any public GitHub repo with a `schema.yml` and get a paginated REST API + a public browsable page, with verbatim-source provenance per cell. No deploy step, no signup — same posture as skills.sh / jsdelivr / raw.githack.

## Current status (v0)

- **Read path is real.** `GET /api/v1/<user>/<repo>[/<frame_path>]/...` resolves `(user, repo, ref) → SHA → events.ndjson + schema.yml from raw.githubusercontent.com → projection in-process → JSON`. Cursor pagination, ETag/304, Link header for next-page.
- **HTML views.** Server-rendered Hono pages. Frame view (entity table with hover-source popovers), entity view (per-field evidence cards), repo index (when no root schema, lists frames in the repo).
- **Multi-frame routing.** URL = filesystem path inside the repo. Auto-discovery via GitHub Trees API; reserved-word parser splits `<user>/<repo>/<frame_path?>/<resource>` cleanly.
- **In-memory cache.** SHA → 60s TTL. Dataset projection per SHA → forever (immutable).

Live demos (localhost:8787 today, public host once Tier 1 is done):

- Single-frame: [microchipgnu/ai-agent-wallets-eu](https://github.com/microchipgnu/ai-agent-wallets-eu) — 13 EU agent-wallet companies, every fact verbatim-sourced.
- Multi-frame: [microchipgnu/ai-agent-wallets](https://github.com/microchipgnu/ai-agent-wallets) — `eu/` + `us/` siblings; root index lists both.

## What's missing — three tiers

### Tier 1 — needed to ship publicly

| # | Item | Why it blocks shipping |
|---|---|---|
| 1 | **Deploy frames-cloud to Cloudflare Workers.** | Everything is `localhost:8787` today. Workers is the right target (cheap edge, fits read-heavy resolver). Half-day work: `wrangler.toml`, swap `Buffer` (used in cursor base64) for `atob`/`btoa`, swap in-memory `Map` cache for KV. |
| 2 | **Persistent cache.** | In-process Maps die on every Worker restart. SHA cache → KV (60s TTL native there). Dataset projections → D1 or R2-backed JSON snapshots keyed by SHA (immutable, so cache is forever). |
| 3 | **Domain.** | Need `frames.dev` or equivalent on Cloudflare. Without it, no shareable URLs. |
| 4 | **Rate limiting.** | Public endpoints with no abuse protection are a free DoS. Per-IP via Durable Objects. |
| 5 | **GitHub webhook for invalidation.** | Today: 60s polling worst case. With webhook: <2s. One-click GitHub App install on a repo. |

### Tier 2 — the actual differentiated features

| # | Item | What it unlocks |
|---|---|---|
| 6 | **MCP HTTP runtime at `/mcp/<user>/<repo>`.** | The agent-runtime moat vs. "just a GitHub data viewer." Same 7 verbs, HTTP transport, anonymous reads, OAuth-gated writes. The page already advertises it; ship the server. |
| 7 | **Write API + GitHub OAuth.** | Read-only is half the product. Writes commit back via GitHub Contents API; batched in a Durable Object so a 50-fact agent burst produces 1 commit, not 50. Commit message: `frames: <agent_id> set <N> facts on <entity_id>`. |
| 8 | **HTML schema view.** | Currently the Schema button links to JSON. Should be its own page with fields, types, required, allowed values, population stats ("`founded_year`: 8/13 entities, 62%"). |
| 9 | **Search + multi-filter.** | One enum field today (`hq_country` chips). Need full-text across string fields, range filters on int/date (`?filter[founded_year][gte]=2020`), AND across multiple fields. |
| 10 | **Open Graph cards.** | Auto-generate `<meta og:*>` per entity and per frame. The "tweet a URL" loop is dead without this. |

### Tier 3 — what turns it into a category

| # | Item | Notes |
|---|---|---|
| 11 | **Discovery / `/explore`.** | Index any public repo with GitHub topic `frames-dataset`. Free SEO, free distribution. |
| 12 | **Custom domains.** | `data.acme.com → frames.dev/acme/...`. The Mintlify-feel piece. CNAME + theme via `frames.yml`. |
| 13 | **x402-paid public reads.** | Datasets that monetize per-query via x402 on the same endpoints. A genuinely new wedge — no one ships this. Free for the dataset owner; pay-per-call for everyone else. |
| 14 | **Entity diff view.** | Per-entity history page showing fact changes side-by-side with old + new sources. Trust comes from being able to see the change. |
| 15 | **Heartbeat / refresh runtime.** | The example readme says "Daily re-verification of homepage + last news source per entity" — still aspirational. Needs a scheduler that re-fetches sources, attaches fresh evidence, deprecates stale facts. Probably a separate Worker on cron + verifier MCP that posts events back through (7). |

## Frame protocol gaps

These are real but small — most can be added without breaking compat:

- **Bulk-write event.** Today setting 5 fields on an entity creates 5 events. A `facts.set_many` event would let agents commit an entity update atomically.
- **Source archive_url auto-backfill.** Web archive integration would be ~30 lines and add huge trust value: verbatim quotes survive the source going down.
- **Verified / freeze event.** Once a fact is manually approved, no auto-replacement should override it. Needs a new event type or a flag on `fact.set`.

## Recommended ordering

1. **Tier 1, items 1–3** (deploy + cache + domain) — turns the demo into a real artifact people can hit. ~1 day.
2. **Tier 2, item 6** (MCP HTTP shim) — the agent-runtime differentiator, and the page already markets it. ~1 day.
3. **Tier 1, items 4–5 + Tier 2, item 7** (rate limit, webhook, write API) — close the read+write loop. ~2 days.
4. **Tier 2, items 8–10** (HTML schema, search, OG cards) — polish that makes shareable URLs convert. ~2 days.
5. **Tier 3** in priority order: 13 (x402-paid), 11 (explore), 14 (diffs), 15 (heartbeat), 12 (custom domains).

The temptation will be to build search, themes, and custom domains early. They're polish on a product that doesn't exist yet at a public URL. Don't do them third.

## Non-goals (for now)

- A frame builder UI. The CLI / `init` story is fine for v1. People who would use this can edit YAML.
- A multi-tenant control plane with accounts. The "GitHub repo = installed dataset" model is the whole pitch. Don't replicate Vercel's dashboard until there's reason to.
- Schema relations / entity references. Real, but big — needs schema 0.2. Not blocking the v1 story.
