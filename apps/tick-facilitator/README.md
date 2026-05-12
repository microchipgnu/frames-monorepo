# tick-facilitator

Self-hosted [Faremeter](https://github.com/faremeter/faremeter) facilitator deployed on Cloudflare Containers. Handles x402 (v1 + v2) and MPP (Solana `charge` intent) verify+settle for [tick](../tick).

Faremeter is a Hono + `@hono/node-server` app. We wrap it in a Node container, front it with a thin Cloudflare Worker that proxies HTTP to the container, region-pin alongside the tick Worker for ~5–15ms colo-local verify hops.

## Architecture

```
[tick Worker]
     │  HTTP /verify, /settle, /facilitator/*
     ▼
[tick-facilitator Worker]
     │  proxies to bound Container
     ▼
[Container: Faremeter apps/facilitator (Node + Hono)]
     │  config from env (patched ~10 lines)
     ├── verifies x402 challenges
     ├── settles via @faremeter/payment-{evm,solana}
     └── exposes MPP charge intent (Solana)
```

## Path 1 (v1 — ship now)

CF Containers, zero modification to Faremeter beyond:
- Patching the config loader to read keypairs from env instead of files (~10 lines, upstream the change)
- Setting `EVM_PRIVATE_KEY` / `SOLANA_ADMIN_KEYPAIR_JSON` / RPC URLs as Worker secrets

## Path 2 (post-alpha)

Swap `@hono/node-server` for native Workers `export default { fetch }`. Sub-millisecond cold start. ~1 day of work. Upstream the adapter so the wider Faremeter ecosystem benefits.

## Secrets

```bash
wrangler secret put SOLANA_ADMIN_KEYPAIR_JSON
wrangler secret put SOLANA_RPC_URL
wrangler secret put EVM_FACILITATOR_PRIVATE_KEY
wrangler secret put EVM_RPC_URLS    # JSON map per supported chain
```

## Status

Scaffolding only. Container image build + Faremeter vendoring lands in week 1.

## See also

- [Faremeter README](https://github.com/faremeter/faremeter) — the upstream we wrap
- [tick PLAN.md §6](../tick/PLAN.md) — facilitator decisions
