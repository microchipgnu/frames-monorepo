> **⚠ MOVED (2026-06-11).** The catalog now lives in
> [`frames-engineering/frames-agent-models-gateway`](https://github.com/frames-engineering/frames-agent-models-gateway)
> at `apps/catalog/`, with content served from the `frames-catalog-content`
> R2 bucket (synced by that repo's `catalog-refresh.yml`; no more git
> commits). The `catalog-refresh` workflow HERE is disabled. The `content/`
> snapshot below is kept FROZEN as the deployed worker's bucket-miss
> fallback source — do not refresh or edit it.

# catalog

The canonical hosted tool catalog for [pay](https://github.com/microchipgnu/pay) — and a per-host **merchant directory** of the agentic economy. One publisher among many — federation lives in pay's `tools.yml`, not here.

Two grains, one pipeline:
- **Per-tool** (`/tools/:id`, `/catalog`) — content-addressed pay v0.0.1 `ToolDescriptor`s. Wire format owned by [pay/SPEC.md](https://github.com/microchipgnu/pay/blob/main/SPEC.md). What `pay add <url>` consumes.
- **Per-merchant** (`/merchants/:host`, `/merchants`, `/search`) — host-keyed entity with liveness / volume / quality signals, embedded `tools[]` sub-list, and per-fact source evidence. What agents read to choose between tools.

Deploys to Cloudflare Workers (default) or Vercel — both first-class.

## Routes

```
GET /tools/:id                   bare descriptor (wire format)
GET /catalog                     list tools w/ q, capability, rail, active, recognized, cursor
GET /catalog/:id                 list-style envelope wrapping one descriptor

GET /merchants                   list merchants w/ q, capability, rail, active, recognized, include_infra, cursor
GET /merchants/:host             single merchant entity w/ embedded tools[]
GET /search?q=&capability=&rail= cross-grain search — returns matching merchants + their tools

GET /_meta                       per-source freshness from last refresh
POST /webhooks/invalidate        evict KV cache (content webhook)
```

Each response carries `ETag`. `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`.

## Where data comes from

7 upstream sources, run in parallel via `Promise.allSettled` — one source failing never kills the rest. Each source has retry + backoff + (where applicable) a committed cache fallback for auth-gated sources.

| Source | Auth | Role |
|---|---|---|
| **Coinbase x402 Bazaar** | none | Primary discovery — every x402-settled paid HTTP resource (~5,800 today) |
| **agentic.market** | none | Friendly names, descriptions, listed pricing, category fallback |
| **pay.sh / pay-skills** | none | MPP discoverability + normalized taxonomy + price ranges |
| **mpp.dev directory** | none | Service-level catalog with endpoint-grained payment metadata |
| **Frames Registry** | none | First-party gateway w/ OpenAPI specs — captures `info.x-guidance` per service for agent steering |
| **mppscan.com** | **SIWX** (wallet sig) | On-chain MPP/Tempo settlement evidence per merchant. Falls back to committed cache when `MPPSCAN_WALLET_PRIVATE_KEY` is missing. |
| **x402scan.com** | **paid x402** (~$0.10/refresh) | Base + Solana per-recipient volume. Joined to merchants via `pay_to[]`. Falls back to committed cache when `X402_WALLET_PRIVATE_KEY` is missing. |

Plus a direct-probe layer:
- **`scripts/probe-discovery.ts`** — runs [`@agentcash/discovery`](https://x402scan.com/discovery-spec) against every bazaar host + sibling hosts (`mpp.foo.com`, `payments.foo.com`). Captures advertised methods/networks/recipients, OpenAPI `info.x-guidance`, per-route input schemas. 7-day result cache so re-running every refresh is cheap.

## Pipeline

```
scripts/
  host.ts                    canonical host + CAIP-2 chain registry + infra-suffix detector
  siwx.ts                    EIP-4361/EIP-191 SIWX client

  scrape-bazaar.ts           ─┐
  scrape-agentic-market.ts    │
  scrape-paysh.ts             │ Promise.allSettled — one fail ≠ pipeline death
  scrape-mpp-directory.ts     │
  scrape-mppscan.ts           │ (SIWX, cache fallback)
  scrape-x402scan.ts          │ (paid x402 via agentcash, cache fallback)
  scrape-frames-registry.ts  ─┘
  scrape-all.ts              orchestrator → staging/refresh-meta.json (per-source freshness)

  probe-discovery.ts         (depends on bazaar output; 7d cache; sibling hosts)

  merge.ts                   alias rollup + cross-source fusion + signal computation
                             → staging/merchants.json

  write-projections.ts       merchants.json + raw items
                             → content/tools/<id>.json + content/merchants/<host>.json
                             → content/index.ndjson + content/merchants.ndjson
                             → content/refresh-meta.json
```

Run with Bun:

```
bun run scrape                   # all 7 scrapers + probe
bun run scrape:paysh             # one source
bun run probe -- --refresh       # force re-probe (bypass 7d cache)
bun run merge                    # fuse staging → merchants.json
bun run project                  # write content/
bun run refresh                  # scrape && merge && project
```

## Signals on every merchant entity

The fields below are why an agent picks one tool over another. All evidenced — each fact carries a source URL in `evidence.<source>`.

| Field | Why it matters |
|---|---|
| `is_active_14d` | Did the bazaar see a settlement in the last 14d? |
| `is_recognized` | Has a human-curated brand name AND isn't infra AND isn't mass-lister |
| `is_infra` | Auto-generated host (Lambda, Vercel, Workers, …) — drop from default search |
| `is_mass_lister` | >500 bazaar resources — usually a spam pattern |
| `listed_on_count` | Cross-validation: 1 source vs. 6 sources |
| `network_names` / `network_tiers` | Friendly names, deduped (`base` + `eip155:8453` count once) |
| `total_calls_30d` | Bazaar `quality.l30DaysTotalCalls` rolled to merchant |
| `tempo_tx_count` / `tempo_volume_usd` | mppscan on-chain evidence |
| `volume_usd_base` / `_solana` / `x402_buyers_30d` | x402scan per-chain split via `pay_to` join |
| `advertises_mpp` / `_x402` / `_siwx` | What the merchant told us in its 402 challenge (probe-discovery) |
| `mpp_source` | `mppscan` (lagging) vs `probe` (leading) vs `both` |
| `x_guidance` | OpenAPI `info.x-guidance` — prose for the agent |
| `per_route_schemas` | How many routes expose an input schema — steerability signal |

## CI / secrets

Two optional secrets:

```bash
MPPSCAN_WALLET_PRIVATE_KEY    # SIWX identity. Any Base private key. No funds needed.
X402_WALLET_PRIVATE_KEY        # x402 payments. USDC on Base. ~$0.10/refresh.
```

Generate a throwaway wallet for SIWX:
```bash
bun -e 'import { generatePrivateKey } from "viem/accounts"; console.log(generatePrivateKey())'
```

Without these, the corresponding scraper writes empty output and the pipeline still completes — the merchant directory just lacks Tempo settlement volume and Base/Solana per-merchant 30d volume.

Cron: `.github/workflows/catalog-refresh.yml` runs every 6 hours, commits diffs back to `main`. Catalog Worker reads main via `raw.githubusercontent.com`, so commit = live deploy.

Validation: `.github/workflows/catalog-validate.yml` checks descriptor + merchant shape on every PR touching `content/`.

## Hand-written descriptors / merchants

Still valid — drop a `.json` file in `content/tools/` or `content/merchants/` matching the shape. CI validates. Category overrides go in `content/category-overrides.json` (`{ "host.com": { "category": "search", "reason": "..." } }`).

## Contributing

1. For a hand-written descriptor: write a JSON conforming to [pay/SPEC.md](https://github.com/microchipgnu/pay/blob/main/SPEC.md#tool-descriptor).
2. PR to this repo. CI validates the file.
3. Merge → webhook → KV invalidate → live in seconds.

## Self-hosting

Fork this repo. Edit `content/tools/`. Deploy via Cloudflare or Vercel using the configs in `server/deploy/`. Point your pay `tools.yml` URLs at your fork — federation by URL.

## Documents

- [PLAN.md](./PLAN.md) — staged build, with progress
