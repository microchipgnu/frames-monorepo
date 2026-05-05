# catalog — Plan

Staged build for the canonical hosted tool catalog at `catalog.frames.ag`.

## C0 — Repo scaffold

- README, PLAN
- `server/` skeleton: `handler.ts`, `cache.ts`, `content.ts`, `types.ts`, `canonical.ts` (JCS), `descriptor-id.ts`
- Cloudflare adapter + Vercel adapter, both with their deploy entry
- `validate.yml` CI

**Status:** done.

## C0.5 — Mirror live discovery sources into content/tools/

The catalog's content is **mirrored** from existing live discovery sources, not hand-curated:

- **Coinbase x402 Bazaar** (`api.cdp.coinbase.com/platform/v2/x402/discovery/resources`) — paginated, paid HTTP resources across Base, Solana, others
- **MPP directory** (`mpp.dev/api/services`) — services with paid endpoints (Anthropic, AgentMail, Wolfram)
- **Frames Registry** (`registry.frames.ag/api/services`) — first-party gateway; each service's OpenAPI spec parsed for x402-secured routes (Twitter, Exa, OpenRouter, Jupiter, near-intents, agentmail, coingecko, ai-gen, wordspace, test)

`scripts/refresh.ts` (Bun) fetches all three, normalizes into pay v0.0.1 ToolDescriptors, writes per-tool JSONs and a sorted `content/index.ndjson`. Run:

```
bun run scripts/refresh.ts                  # full refresh (all sources)
bun run scripts/refresh.ts --limit 20       # sample
bun run scripts/refresh.ts --source frames  # bazaar | mpp | frames
```

Current mirror: **5,797 descriptors** (5,079 Bazaar + 669 MPP + 49 Frames Registry; ~20 Bazaar slug collisions silently overwritten — fix in C0.6).

**Status:** done.

## C0.6 — Refresh quality fixes

- Slug collisions: append a content-hash suffix when two normalized IDs collide (today the second overwrites)
- MPP capabilities are sometimes empty (`["unspecified"]`) — enrich via service category mapping
- Bazaar tools with `quality.l30DaysTotalCalls == 0` and no recent activity: filter out as spam, or tag separately
- Asset symbol detection for non-USDC tokens

Effort: ½ day.

## C0.7 — Server pagination + index for `/catalog`

`scripts/refresh.ts` writes a sorted `content/index.ndjson` (one full descriptor per line, 3.9 MB at 5,768 entries) alongside the per-file descriptors. The `/catalog` handler reads the index in one fetch (cached in KV), filters by capability, and paginates by cursor (last-id-seen). Full descriptors still resolve from `/tools/<id>.json` for direct lookup.

Default page size 100, max 500. Cursor-based: `?cursor=<last-id>&limit=N&capability=<tag>`.

**Status:** done.

## C1 — Local validation against pay (1 day)

Run the Worker locally with `wrangler dev`. Run pay's CLI (when v0.0.2 ships) against `http://localhost:8787/tools/search.exa`. Verify ETag matches `descriptor_id`. Verify `pay add http://localhost:8787/tools/search.exa` writes a correct lock entry.

**Exit:** end-to-end resolve through a local catalog works.

## C2 — Production deploy (½ day)

Deploy to Cloudflare. Bind `catalog.frames.ag` DNS. Verify ETag/SWR behavior at the edge. Update pay's default catalog URL.

**Exit:** `pay add https://catalog.frames.ag/tools/search.exa` works against production.

## C3 — Free + BYOK descriptors (when pay/SPEC.md v0.0.2 lands)

Once SPEC adds `payment.protocol: "none"` and `"byok"`:
- Add `github.repo.json` (`none`)
- Add `github.search.json` (`none`)
- Optionally `extract.openai.json` (`byok`)

**Exit:** catalog covers free + paid + BYOK paths.

## C4 — Webhook invalidation (1 day)

GitHub webhook on this repo POSTs `/webhooks/invalidate` after merge to main. KV evicts. Next request reloads from raw.githubusercontent.com.

**Exit:** descriptor changes go live in <10s after merge.

## C5 — Deploy CI (½ day)

`deploy-cloudflare.yml` and `deploy-vercel.yml`. Manual `workflow_dispatch` initially, auto-on-push once stable.

**Exit:** merge → automatic deploy.

## C6 — `pay catalog validate` + `pay catalog test` (in pay repo, not here)

CLI tools authors use to lint and test descriptors locally before opening a PR. Lives in pay repo; referenced from this repo's contribution guide.

## Future — Frame-dataset migration

When the catalog grows past ~30 tools or pricing changes more than weekly, migrate `content/` to a frame dataset (`schema.yml`, `events.ndjson`, `prompt.md` for tick-driven refresh). The JSON files in `content/tools/` become the projection output. The Worker's read path doesn't change.

Trigger: manual editing becomes the bottleneck. Don't pre-build.

## Boundaries

What this repo IS:
- One canonical hosted catalog
- A reference implementation of a catalog server

What this repo is NOT:
- The wire format spec (that's pay/SPEC.md)
- A federator (federation lives in pay's `tools.yml`)
- Authoritative — anyone can self-host their own catalog with the same code
