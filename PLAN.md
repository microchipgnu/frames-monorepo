# catalog — Plan

Staged build for the canonical hosted tool catalog at `catalog.frames.ag`.

## C0 — Repo scaffold

- README, PLAN
- `server/` skeleton: `handler.ts`, `cache.ts`, `content.ts`, `types.ts`, `canonical.ts` (JCS), `descriptor-id.ts`
- Cloudflare adapter + Vercel adapter, both with their deploy entry
- `validate.yml` CI

**Status:** done.

## C0.5 — Mirror Bazaar + MPP into content/tools/

The catalog's content is **mirrored** from the existing live discovery sources, not hand-curated:

- **Coinbase x402 Bazaar** (`api.cdp.coinbase.com/platform/v2/x402/discovery/resources`) — paginated, paid HTTP resources across Base, Solana, others
- **MPP directory** (`mpp.dev/api/services`) — services with paid endpoints (Anthropic, AgentMail, etc.)

`scripts/refresh.ts` (Bun) fetches both, normalizes each entry into a pay v0.0.1 ToolDescriptor, and writes to `content/tools/<slugged-id>.json`. Run:

```
bun run scripts/refresh.ts                  # full refresh
bun run scripts/refresh.ts --limit 20       # sample
bun run scripts/refresh.ts --source bazaar  # one source
```

Initial mirror produced **5,748 descriptors** (5,099 Bazaar + 669 MPP, with ~20 slug collisions silently overwritten — known issue, fix in C0.6).

**Status:** done.

## C0.6 — Refresh quality fixes

- Slug collisions: append a content-hash suffix when two normalized IDs collide (today the second overwrites)
- MPP capabilities are sometimes empty (`["unspecified"]`) — enrich via service category mapping
- Bazaar tools with `quality.l30DaysTotalCalls == 0` and no recent activity: filter out as spam, or tag separately
- Asset symbol detection for non-USDC tokens

Effort: ½ day.

## C0.7 — Server pagination for `/catalog`

With ~6,000 descriptors, the current `/catalog` handler fetches each one to build the list response. That's too many subrequests per call. Two fixes needed before public deploy:

1. Pre-build a `content/index.json` during refresh containing only `(id, title, capabilities, payment.network, payment.protocol)` per tool. Worker reads that one file for `/catalog` and `/catalog?capability=…`. Full descriptors are still fetched on-demand from `/tools/:id`.
2. Cursor-based pagination for `/catalog` since 6,000 items shouldn't ship in one response.

Effort: ½ day. Required before C2.

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
