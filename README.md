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

## Adding a tool

1. Write a descriptor in `content/tools/<id>.json` conforming to [pay/SPEC.md](https://github.com/microchipgnu/pay/blob/main/SPEC.md#tool-descriptor).
2. Validate locally: `pay catalog validate content/tools/<id>.json` (when pay v0.0.2 ships).
3. PR to this repo. CI validates.
4. Merge → webhook → KV invalidate → live in seconds.

## Self-hosting

Fork this repo. Edit `content/tools/`. Deploy via Cloudflare or Vercel using the configs in `server/deploy/`. Point your pay `tools.yml` URLs at your fork — federation by URL.

## Documents

- [PLAN.md](./PLAN.md) — staged build, with progress
