# catalog

The canonical hosted tool catalog for [pay](https://github.com/microchipgnu/pay). One publisher among many — federation lives in pay's `tools.yml`, not here.

Public read-only HTTP API serving content-addressed `ToolDescriptor` JSON. Backed by hand-curated descriptors in `content/tools/`. Deploys to Cloudflare Workers (default) or Vercel — both first-class.

Wire format: see [pay/SPEC.md](https://github.com/microchipgnu/pay/blob/main/SPEC.md).

## Routes

```
GET /catalog                    list all tools
GET /catalog?capability=<tag>   filter by capability
GET /catalog/:id                list-style envelope wrapping one descriptor
GET /tools/:id                  bare descriptor (the wire format manifests consume)
POST /webhooks/invalidate       evict KV cache (called from a content-repo webhook)
```

Each response carries `ETag` matching the descriptor's `descriptor_id`. `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`.

## Where descriptors come from

Most descriptors are **mirrored from existing live discovery sources**, not hand-written:

- **Coinbase x402 Bazaar** — `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` (Base, Solana, …)
- **MPP directory** — `https://mpp.dev/api/services` (Anthropic, AgentMail, …)

`scripts/refresh.ts` pulls both, normalizes each entry into a pay v0.0.1 `ToolDescriptor`, and writes to `content/tools/<slug>.json`. Run with Bun:

```
bun run scripts/refresh.ts                  # full refresh
bun run scripts/refresh.ts --limit 50       # sample
bun run scripts/refresh.ts --source bazaar  # one source
```

Hand-written descriptors are also valid — drop a `.json` file in `content/tools/` matching the SPEC. CI validates both.

## Contributing

1. For a hand-written descriptor: write a JSON conforming to [pay/SPEC.md](https://github.com/microchipgnu/pay/blob/main/SPEC.md#tool-descriptor).
2. PR to this repo. CI validates the file.
3. Merge → webhook → KV invalidate → live in seconds.

## Self-hosting

Fork this repo. Edit `content/tools/`. Deploy via Cloudflare or Vercel using the configs in `server/deploy/`. Point your pay `tools.yml` URLs at your fork — federation by URL.

## Documents

- [PLAN.md](./PLAN.md) — staged build, with progress
