# merchants-watch

Live directory of x402/MPP merchants — every host accepting paid HTTP requests across the agentic economy. Aggregates the Coinbase x402 Bazaar, agentic.market, and pay.sh / Solana Foundation pay-skills into one per-host view: networks accepted, rail coverage, resource count, last activity.

A [frame](https://github.com/frames-ag/frame): one entity per merchant host, every fact evidenced, refreshed on a schedule, queryable as JSON or SQL.

## What's in here

- `schema.yml` — entity shape (host, display_name, category, networks_accepted, listed_on flags, …).
- `events.ndjson` — append-only event log; each tick adds `set_facts` events with merge output and links a source URL as evidence per fact.
- `scripts/`
  - `scrape-bazaar.ts` — walks the Coinbase Bazaar (CDP discovery, free, no auth) page by page; groups resources by host.
  - `scrape-agentic-market.ts` — paginates `api.agentic.market/v1/services`.
  - `scrape-paysh.ts` — `pay.sh/api/catalog` (Solana Foundation pay-skills).
  - `scrape-mppscan.ts` — SIWX-authenticated walk of `mppscan.com` for Tempo on-chain volume per merchant. Falls back to `staging/mppscan-cache.json` when `MPPSCAN_WALLET_PRIVATE_KEY` is missing.
  - `scrape-x402scan.ts` — paid-x402 walk of `x402scan.com` for Base + Solana on-chain volume per recipient address. Falls back to `staging/x402scan-cache.json` (currently a placeholder — see *Deferred* below).
  - `siwx.ts` — minimal Sign-In With X client. Constructs the EIP-4361/SIWE canonical message from a 402 challenge and signs with EIP-191 (`viem`'s `signMessage`). Caches the Authorization header per origin until expiry.
  - `scrape-all.ts` — runs the scrapers in parallel.
  - `merge.ts` — dedupes by canonical host, unions networks, normalizes category onto pay.sh's taxonomy, flags mass-listers and 14-day-active hosts.
  - `fold.ts` — calls into `@frames-ag/frame` to commit merged entities to `events.ndjson` with per-field evidence and diff-aware emission.
  - `host.ts` — canonicalHost / entityIdFromHost / CAIP-2 chain registry (Base, Solana, Polygon, Arbitrum, Stellar, Algorand, X Layer, …).
- `.github/workflows/tick.yml` — runs the scrape + merge + fold every 6 hours and commits any changes.

## Sources

| Source | Auth | Role |
|---|---|---|
| Coinbase Bazaar | none | primary directory — every x402-settled resource, with networks + schemas |
| agentic.market | none | friendly names, descriptions, category fallback, listed pricing |
| pay.sh / pay-skills | none | MPP discoverability flag, normalized category, price range |
| mppscan | **SIWX (wallet signature)** | Tempo on-chain volume per merchant (MPP-on-Tempo settlements that don't appear in the bazaar) |
| x402scan | **paid x402 (~$0.02/refresh)** | Base + Solana per-merchant volume — *dormant, awaiting wallet plan from `frames-monorepo`* |

## CI wallet setup

`mppscan` is SIWX-protected — every request needs a wallet signature. Set the **`MPPSCAN_WALLET_PRIVATE_KEY`** GitHub Actions secret on this repo with any Base-mainnet private key (no funds required; the wallet only proves identity). Without it, CI will fall back to `staging/mppscan-cache.json` — the directory stays accurate but Tempo volume numbers freeze.

To generate a throwaway wallet for this:

```bash
bun -e 'import { generatePrivateKey } from "viem/accounts"; console.log(generatePrivateKey())'
```

…then copy-paste into the repo's Settings → Secrets and variables → Actions.

## Deferred

- **x402scan wallet** — the scraper, the join logic, the schema fields, and the CI hook are all shipped. What's *not* shipped is a dedicated wallet for this repo to fund per-tick x402 calls (~$0.02/refresh). The plan is to plumb this through the `frames-monorepo` wallet strategy when that lands; until then the `X402_WALLET_PRIVATE_KEY` secret stays unset and `staging/x402scan-cache.json` is an empty placeholder. The Base/Solana per-merchant volume columns will read as 0 on the dashboard. Everything else (rail coverage, Tempo volume via mppscan, recognized-merchant prospect ranking) works without it.

## Running locally

```bash
bun install
bun run scrape       # writes staging/{bazaar,agentic-market,paysh}.json
bun run merge        # writes staging/merged.json
bun run fold         # appends to events.ndjson
```

Or `bun run tick` to do all three (deterministic phase only).

### Two-phase tick

The dataset is maintained in **two phases**:

| Phase | Owns | Driver |
|---|---|---|
| **Scrape** (deterministic) | identity + rail truth: `host`, `networks_accepted`, `on_*`, `bazaar_*`, `tempo_*`, `volume_*`, `probe_*`, `advertises_*`, `is_active_14d`, `is_mass_lister`, `is_infra` | `scripts/scrape-all.ts` → `merge.ts` → `fold.ts` (`bun run tick`) |
| **Curate** (agentic) | naming + semantic + recognition gaps: `display_name`, `description`, `category` (with `category_source = "claude_inferred"`), `is_recognized` — plus a bounded net-new discovery slice | OpenProse contracts under `.agents/prose/src/` |

Run the full two-phase pipeline:

```bash
bun run tick:full    # equivalent to: bun run tick && bun run curate
```

Run just the curate phase against a frame already populated by `bun run tick`:

```bash
bun run curate
```

`bun run curate` shells out to `opencode run "prose run …"`. OpenProse
is not a separate binary — the contract files under `.agents/prose/src/`
are interpreted by an LLM agent (opencode, claude-code, or any harness
with the `open-prose` skill) that embodies the OpenProse VM
in-session. Each invocation writes a run snapshot under
`.agents/prose/runs/<timestamp>/` with the resolved contract, per-service
workspaces, and a `vm.log.md` execution trace.

The curate phase needs an agentwallet configured for `pay-mcp` and an
`OPENROUTER_API_KEY` (or another LLM provider opencode is configured for).
Its budget is bounded — default `$0.75` USDC per run across exa /
serper / firecrawl / twitter calls; the contract hard-stops at the
ceiling. See `.agents/prose/src/curate.prose.md` for the full parameter
list and per-service contracts.

To run the curate phase from inside Claude Code interactively (instead
of via opencode), just type:

```
prose run datasets/merchants-watch/.agents/prose/src/curate.prose.md
  frame=datasets/merchants-watch budget_usd=0.75 …
```

— the `open-prose` skill activates on the `prose run` prefix.

`scripts/merge.ts` reads back curate-written `display_name`,
`description`, `category` (when `category_source = "claude_inferred"`)
on the next deterministic tick, so agentic enrichments survive across
runs — they only get overwritten when a higher-authority source
(pay.sh, agentic.market) starts catalogues the host.

## Querying

Locally with [`@frames-ag/frame`](https://www.npmjs.com/package/@frames-ag/frame):

```bash
bunx -y @frames-ag/frame query . --field is_active_14d=true --field network_count=1 --with-sources
bunx -y @frames-ag/frame query . --sql \
  "SELECT category, COUNT(*) AS single_rail
   FROM rows
   WHERE is_active_14d = true AND network_count = 1
   GROUP BY category ORDER BY single_rail DESC"
```

Once published, the live API is served by Frames Cloud at:

- **JSON API**: `https://frames.ag/api/datasets/v1/<owner>/merchants-watch/entities`

## Powered by

- [Coinbase x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar)
- [agentic.market](https://agentic.market)
- [pay.sh](https://pay.sh) / [solana-foundation/pay-skills](https://github.com/solana-foundation/pay-skills)
- [@frames-ag/frame](https://www.npmjs.com/package/@frames-ag/frame)
