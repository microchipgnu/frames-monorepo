# pay — Plan

Staged implementation plan. Each stage has an exit criterion and ships independently.

## Stage 0 — Contracts (1 day)

Write the load-bearing artifacts before any code.

- [ ] `SPEC.md` — done. Review and lock v0.0.1.
- [ ] `src/types.ts` — TypeScript translations of every interface in SPEC. No implementation, just types.
- [ ] `src/canonical.ts` — JCS (RFC 8785) implementation. Single function: `canonicalize(value) → string`. ~80 LOC, no deps.
- [ ] `src/descriptor-id.ts` — `descriptorId(descriptor) → string` returning `"sha256-" + base64url(sha256(canonicalize(descriptor)))`.
- [ ] Three example descriptors under `examples/descriptors/` (Exa, Firecrawl, agentwallet) with their pre-computed `descriptor_id`s in `examples/descriptors/EXPECTED.txt`. Round-trip test: parse → canonicalize → hash matches.
- [ ] One example `tools.yml` + `tools.lock` pair under `examples/manifest/` referencing the three descriptors.

**Exit:** SPEC.md unchanged for 48h. Types compile. The three example descriptors hash to their expected `descriptor_id`s deterministically across two runs.

## Stage 1 — Library: minimum viable wallet (4 days)

Build the orchestrator on top of faremeter. The entire wire layer (signing, x402 negotiation, HTTP retry) comes from `@faremeter/*`. Pay owns catalog, manifest, budget, audit, and frame integration.

### Faremeter dependencies (no code; just install)

| Package | Why |
|---|---|
| `@faremeter/fetch` | `wrap(fetch, { handlers })` — the 402 round-trip engine |
| `@faremeter/payment-evm` | x402 EVM handler (USDC on Base, etc.) |
| `@faremeter/payment-solana` | x402 Solana handler (SPL token) |
| `@faremeter/wallet-ows` | OWS-backed signing (EVM + Solana) — the v0 default |
| `@faremeter/wallet-evm` | local-keypair fallback for tests |
| `@faremeter/wallet-solana` | local-keypair fallback for tests |
| `@faremeter/types` | x402v2 + MPP type vocabulary |
| `@faremeter/info` | known-token registries (USDC addresses per chain) |

### Pay-owned modules

| Module | Source | Purpose | LOC est. |
|---|---|---|---:|
| `wallet/dispatch.ts` | new | `WalletAdapter.payForTool` orchestrator | ~150 |
| `wallet/faremeter-bridge.ts` | new | `descriptor.payment` → faremeter handler factory | ~120 |
| `wallet/wallet-registry.ts` | new | user's faremeter wallets keyed by network | ~80 |
| `wallet/budget.ts` | `@websets/wallet` | per-call/run/month caps + faremeter pre-flight balance | ~120 |
| `wallet/audit-log.ts` | `@websets/wallet` | Ed25519-signed receipts | ~150 |
| `wallet/ledger.ts` | `@websets/wallet` | append-only ledger | ~234 |
| `wallet/wallet-state.ts` | `@websets/wallet` | persistent state | ~140 |
| `catalog/static.ts` | new | `StaticCatalog` from JSON | ~60 |
| `catalog/http.ts` | adapted from `@websets/catalog/frames-registry-catalog.ts` | `HttpCatalog` | ~199 |
| `catalog/build-invocation.ts` | `@websets/catalog/build-invocation.ts` | descriptor → ResolvedInvocation | ~145 |
| `manifest/load.ts` | new | parse `tools.yml`, validate against schema | ~120 |
| `manifest/lock.ts` | new | read/write `tools.lock`, integrity check | ~140 |
| `manifest/resolve.ts` | new | implements the SPEC resolution algorithm | ~140 |
| `frame/event.ts` | new | append `tool.invoked` events to a frame's `events.ndjson` | ~80 |
| `stores/memory.ts` | new | `MemoryStore` for tests | ~60 |
| `stores/filesystem.ts` | new (extracted from gateway's FS store) | `FilesystemStore` default | ~120 |
| `canonical.ts` + `descriptor-id.ts` | new (Stage 0) | JCS + descriptor SHA | ~120 |

**Total: ~2,178 LOC.** Down from ~3,300 (custom wallet stack) and ~6,576 (full websets-impl extraction). Faremeter eats the difference.

**Dropped entirely** (replaced by faremeter): `wallet/wallet.ts` orchestrator's protocol/signer machinery, `wallet/protocol-clients.ts`, `protocol-x402/*`, `signer-ows/*`, scoped tokens, MPP impl, gateway glue. We keep the *names* `wallet/dispatch.ts` etc. but the bodies are bridges, not implementations.

**Exit:** `pnpm test` passes three smoke tests:
1. Manifest path: `tools.yml` declares one tool, `pay install` writes the lock, `payForTool({ name })` resolves from lock and pays a real x402 endpoint with `@faremeter/wallet-ows`.
2. Direct path: `payForTool({ name: <descriptor-url> })` works without a manifest.
3. Multi-network: a manifest with one Solana tool and one EVM tool resolves the right faremeter wallet per call from the wallet registry.

All three produce receipts with valid `descriptor_id`, `wallet_id`, and `facilitator_url`.

## Stage 2 — CLI (4 days)

Single binary. Two command families: **manifest-aware** (npm-shaped) and **direct** (one-shot calls).

**Manifest-aware** (operates on `tools.yml` + `tools.lock` in cwd):

```
pay init                               # scaffold an empty tools.yml
pay add <url> [--as <name>]            # add a tool, fetch descriptor, lock it
pay install                            # resolve every entry in tools.yml, write tools.lock
pay update [<name>]                    # re-fetch and re-pin (deliberate, no auto-update)
pay outdated                           # show locked descriptors whose upstream content has changed
pay run <name> --params <json>         # resolve from lock, pay, return result
pay list                               # show tools in the manifest with lock status
```

**Direct** (no manifest required):

```
pay tool <url-or-descriptor-id> --params <json>    # one-shot call
pay catalog list [--catalog <url>]                  # browse a catalog
pay catalog show <tool-id> [--catalog <url>]        # print one descriptor
```

**Wallet ops** (always available):

```
pay wallet status                      # balance, budget, recent receipts
pay receipt show <receipt-id>          # full receipt JSON
pay receipts list [--since <ts>]       # tail the audit log
```

Configuration: `~/.frames/pay/config.json` for default catalog URL, default signer, budget caps. CLI flags override. Per-project overrides via `pay.config.yml` next to `tools.yml`.

**Exit:**
1. `pay init && pay add https://catalog.frames.ag/tools/search.exa --as search && pay install && pay run search --params '{"query":"…"}'` works in a fresh directory.
2. The resulting `tools.lock` is committable and a fresh clone of the same directory runs `pay run search …` offline (no network for resolution).

## Stage 3 — Hosted catalog server (2 days)

Separate deploy. Cloudflare Worker, Hono. Just a publisher of descriptor JSONs at stable URLs — no opinion beyond that.

- Three routes per SPEC: `GET /catalog`, `GET /catalog/:id`, `GET /catalog?capability=…`
- A fourth read endpoint: `GET /tools/:id` returning the bare descriptor JSON (this is what `tools.yml` URLs point at). The `/catalog/:id` form wraps it in metadata; `/tools/:id` is the wire format manifests consume.
- KV cache, ETag, SWR. Each descriptor's ETag is its `descriptor_id`.
- Source: descriptors live as JSON files in a `catalog-content/` directory in this repo OR a separate `catalog-content` repo, served via raw.githubusercontent.com.
- Webhook on the source repo invalidates KV.
- One canonical deploy at `catalog.frames.ag` (or wherever).

**No federation logic.** Federation is a consumer-side concern: a manifest can mix URLs from many publishers. The server publishes, it does not federate.

**Exit:** `curl https://catalog.frames.ag/tools/search.exa` returns a descriptor whose `sha256(jcs(...))` matches the server's `ETag`. CLI's `pay add https://catalog.frames.ag/tools/search.exa` resolves and locks correctly.

## Stage 4 — MCP server (3 days)

`pay serve` exposes the wallet over MCP. Mirrors `frame serve`. Manifest-aware: the server reads `tools.yml` + `tools.lock` from the directory it's launched in.

Tools exposed:
- `list_tools()` → tools in the manifest with their lock status
- `add_tool(url: string, as?: string)` → fetch, lock, return descriptor
- `pay_tool(name: string, params: object)` → `{ body, receipt }` — `name` is a local manifest name, URL, or `descriptor_id`
- `discover(capability?: string, catalog?: string)` → browse a catalog (default: configured)
- `wallet_status()` → balance, recent receipts, budget remaining

`pay init-mcp` writes a `.mcp.json` in the cwd so any MCP client picks it up.

**Exit:** Claude Code launched in a directory with `tools.yml` + `.mcp.json` can list, call, and discover tools — no extra wiring. Calls produce receipts and (if the directory is also a frame dataset) `tool.invoked` events in `events.ndjson`.

## Stage 5 — Skill (1 day)

`skill/SKILL.md` with recipes for the common workflow patterns:
- "I need to search the web — find me a tool and use it"
- "Show me what I spent today"
- "Set a $10 budget for this run"

Symlink pattern: `ln -s ~/src/pay-repo/skill ~/.claude/skills/pay`. Same as `frames`.

**Exit:** A Claude Code session in a fresh directory can install the skill, init MCP, and call a paid tool in under three turns.

## Stage 6 — Additional faremeter wallet types (when a real consumer asks)

Faremeter ships these out of the box; pay just needs to expose them in CLI/config:

| Wallet | Use case | Faremeter package |
|---|---|---|
| `crossmint` | custodial wallets (no key handling for users coming from agentwallet-style UX) | `@faremeter/wallet-crossmint` |
| `solana-squads` | DAO / shared-treasury multisig | `@faremeter/wallet-solana-squads` |
| `ledger` | hardware-secured signing | `@faremeter/wallet-ledger` |
| `evm` local keypair | dev / CI | `@faremeter/wallet-evm` |
| `solana` local keypair | dev / CI | `@faremeter/wallet-solana` |

Adding a new wallet type = ~30 LOC in `wallet/wallet-registry.ts` (config schema + factory call) plus CLI plumbing. No SPEC changes.

## Stage 6.5 — x402v2 + MPP (when faremeter ships full handler coverage)

Pay's `descriptor.payment.protocol` already supports `x402v2` and `mpp` per SPEC. The bridge needs:
- v2 handler factory wired in `wallet/faremeter-bridge.ts` (~20 LOC)
- MPP `MPPMethodHandler` chain support (~50 LOC)

Today: charge intent works on MPP buyer side. Session/streaming intents come when faremeter ships them.

## Stage 7 — Scale

Only after a real load problem surfaces:
- Cloud `LedgerStore` / `WalletStateStore` / `AuditLogStore` (Postgres, R2, KV)
- Reservation-token budget enforcement for concurrent calls
- Server-side catalog federation (dedupe upstream sources behind `catalog.frames.ag`)
- Multi-region wallet coordination (Durable Objects for channel pinning)

## Boundaries

What this repo is responsible for:
- The library, CLI, MCP server, skill
- The hosted catalog server (one deploy)
- The contracts in SPEC.md

What this repo is **not** responsible for:
- The wire layer (signing, x402/MPP negotiation, HTTP retry) — that's faremeter
- The seller side of x402 — that's `registry`
- The hosted custodial wallet — that's `agentwallet`
- The dataset format — that's `frame`
- New wallet types or chains — those ship in faremeter and become available to pay automatically

## Distribution

- Library: `npm install @frames-ag/pay`
- CLI: `npm install -g @frames-ag/pay-cli` or `bunx @frames-ag/pay-cli`
- Catalog server: Cloudflare Worker, deployed via `wrangler`
- Skill: `ln -s` from a `git clone`

## Success criterion

A workflow author who wants their agent to call paid tools can:

1. **Manifest path** (the npm-shaped story):
   ```
   pay init && pay add https://catalog.frames.ag/tools/search.exa --as search
   pay run search --params '{"query":"..."}'
   ```
   Commit `tools.yml` + `tools.lock`. Anyone who clones the repo runs the same tools at the same SHAs.

2. **Library path**:
   ```ts
   const wallet = createWallet({ signer: owsSigner(...) });
   const { body, receipt } = await wallet.payForTool({ name: "search", params: {...} });
   ```
   Reads `tools.yml` + `tools.lock` from cwd automatically. Under 5 lines of setup.

3. **MCP path**:
   `.mcp.json` points at `pay serve`. Any agent harness calls `pay_tool("search", {...})` with no code.

4. **Frame integration**: a frame dataset's `events.ndjson` automatically gets `tool.invoked` events that pin every paid call to a `descriptor_id` in `tools.lock`. Re-runs are deterministic.

If any of (1)-(3) takes more than 10 minutes from zero, the design is wrong.
