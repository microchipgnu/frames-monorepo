# catalog — deploy runbook

Verified step-by-step deploy for `catalog.frames.ag`. Each step is a single command. Run from `apps/catalog/server/`.

Estimated time: 20-30 min, mostly waiting on DNS propagation.

## Prereqs

```bash
# Tools (one-time)
bun --version           # ≥ 1.3
bunx wrangler --version # ≥ 3.80
gh auth status          # for setting CI secrets later

# Cloudflare auth (one-time)
bunx wrangler login     # browser-based; pick the right account
```

## Step 1 — Provision the KV namespace (one-time)

The `wrangler.toml` currently has a placeholder ID (`c46dbd843c834eabb842028b1bd700e1`) that points at a namespace that may not be yours. Create your own.

```bash
cd apps/catalog/server
bunx wrangler kv namespace create CATALOG_KV --config deploy/cloudflare/wrangler.toml
```

Output looks like:
```
🌀 Creating namespace with title "catalog-CATALOG_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "CATALOG_KV", id = "abc123…" }
```

**Copy the `id`** and replace the placeholder in `apps/catalog/server/deploy/cloudflare/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CATALOG_KV"
id = "abc123…"   # ← paste new id here
```

Commit this change:
```bash
git add apps/catalog/server/deploy/cloudflare/wrangler.toml
git commit -m "catalog: production KV namespace id"
```

## Step 2 — Set production secrets

The Worker reads two secrets:
- `GITHUB_TOKEN` — only needed if `content/` lives in a **private** repo. Skip if public.
- `WEBHOOK_SECRET` — guards `POST /webhooks/invalidate` against random hits. Pick a long random string.

```bash
# WEBHOOK_SECRET — paste a fresh value when prompted
openssl rand -hex 32 | bunx wrangler secret put WEBHOOK_SECRET --config deploy/cloudflare/wrangler.toml

# GITHUB_TOKEN — only if your monorepo is private
# bunx wrangler secret put GITHUB_TOKEN --config deploy/cloudflare/wrangler.toml
```

## Step 3 — Make sure `content/` is committed

The Worker reads from `raw.githubusercontent.com/<owner>/<repo>/main/apps/catalog/content/`. So the freshly-refreshed content needs to be on main.

```bash
git status apps/catalog/content
git add apps/catalog/content
git commit -m "catalog: initial content snapshot"
git push origin main
```

## Step 4 — Deploy the Worker

```bash
bunx wrangler deploy --config deploy/cloudflare/wrangler.toml
```

Output ends with:
```
Published catalog (...)
  https://catalog.<your-subdomain>.workers.dev
```

**Smoke test** before adding DNS:
```bash
WORKER=https://catalog.<your-subdomain>.workers.dev
curl -s $WORKER/ | jq .name              # → "catalog"
curl -s "$WORKER/merchants?limit=3" | jq '.merchants | map(.host)'
curl -s "$WORKER/search?q=web+search&limit=3" | jq '.tools | map(.id)'
```

If any of those 500s, check the `content_base` field at `/`:
```bash
curl -s $WORKER/ | jq .content_base
```
Should be the raw.githubusercontent URL. If it's `localhost:4000`, your dev env-var leaked into production — verify wrangler.toml has no `CATALOG_CONTENT_BASE` outside `[env.X]` blocks (there shouldn't be any env block at all in production config).

## Step 5 — DNS for `catalog.frames.ag`

In Cloudflare dashboard for `frames.ag` zone:
1. Add a Worker route: `catalog.frames.ag/*` → Worker `catalog`
2. Add a DNS record: `CNAME catalog → <subdomain>.workers.dev` (or proxy via CF)

Or via wrangler (if `frames.ag` is in the same CF account):
```bash
bunx wrangler deploy --route catalog.frames.ag/* --config deploy/cloudflare/wrangler.toml
```

Then:
```bash
curl -s https://catalog.frames.ag/ | jq .name
```

## Step 6 — Update default catalog URL in `pay`

In `packages/pay/src/catalog/http.ts` (or wherever `defaultCatalog` is defined), point at production:

```ts
const DEFAULT_BASE = "https://catalog.frames.ag";
```

## Step 7 — Verify the CI refresh cron

The cron is in `.github/workflows/catalog-refresh.yml`, runs every 6h. To trigger manually:

```bash
gh workflow run catalog-refresh.yml
gh run watch
```

After the first successful run, check that `content/refresh-meta.json` is updated on main, then re-hit `https://catalog.frames.ag/_meta` to confirm the Worker is serving the fresh data.

## Step 8 — Validate end-to-end

Each `pay add` resolves through the catalog. Final sanity:

```bash
# Pick a real curated tool from the index
TOOL=$(curl -s 'https://catalog.frames.ag/catalog?recognized=true&limit=1' | jq -r '.tools[0].id')
echo "Resolving $TOOL"

curl -s "https://catalog.frames.ag/tools/$TOOL" | jq '{id, title, payment: {network: .payment.network, currency: .payment.currency, price_hint: .payment.price_hint}}'

# pay should then be able to consume:
# pay add https://catalog.frames.ag/tools/$TOOL
```

## Common failures

| Symptom | Diagnosis | Fix |
|---|---|---|
| `KV namespace not found` | `wrangler.toml` has placeholder id | Step 1: create + replace id |
| All routes 500 | Worker can't reach content base | `curl $WORKER/ | jq .content_base` — should be raw.githubusercontent |
| `/catalog` returns `[]` | `content/` not committed to main yet | Step 3: push content |
| `/_meta` returns 404 | First cron hasn't run yet | Step 7: trigger manually |
| `/tools/<id>` returns 404 for known id | KV cache poisoned with stale 404 | `POST /webhooks/invalidate` with `x-webhook-secret: $WEBHOOK_SECRET` |
| Worker deploy fails on `compatibility_date` | wrangler version drift | `bun add -D wrangler@latest` in `server/` |

## Rollback

```bash
# Roll the Worker back to the previous version
bunx wrangler rollback --config deploy/cloudflare/wrangler.toml
```

KV is content-addressed by descriptor_id; cache invalidation is idempotent. Reverting `content/` on main is enough to roll data back.

## What's NOT in this runbook

- **Vercel deploy** (alt path) — `cd server && bun run deploy:vercel`, set the same env vars in Vercel project config. Same content base; different cache adapter.
- **Custom catalog URL for `pay add`** — that's a tools.yml change in `pay`, not here.
- **Federation with other catalogs** — multi-catalog setup is handled in `pay`'s `tools.yml`, each with its own URL.
