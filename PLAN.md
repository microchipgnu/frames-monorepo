# pay — Plan

Staged implementation plan. Each stage has an exit criterion and ships independently.

## Stage 0 — Contracts (½ day)

Write the load-bearing artifacts before any code.

- [ ] `SPEC.md` — done. Review and lock v0.0.1.
- [ ] `src/types.ts` — TypeScript translations of every interface in SPEC. No implementation, just types.
- [ ] One example `tools.json` with three real descriptors (Exa, Firecrawl, agentwallet) to validate the descriptor shape.

**Exit:** SPEC.md unchanged for 48h. Types compile. Examples parse.

## Stage 1 — Library: minimum viable wallet (1 week)

Lift trimmed code from `websets-impl` per the module audit. ~3,300 LOC.

| Module | Source | Purpose |
|---|---|---|
| `wallet/wallet.ts` | `@websets/wallet` | `WalletAdapter` orchestrator |
| `wallet/budget.ts` | `@websets/wallet` | per-call/run/month caps |
| `wallet/audit-log.ts` | `@websets/wallet` | Ed25519 receipts |
| `wallet/ledger.ts` | `@websets/wallet` | append-only ledger |
| `wallet/wallet-state.ts` | `@websets/wallet` | persistent state |
| `wallet/protocol-clients.ts` | `@websets/wallet` | protocol registry |
| `protocol-x402/*` | `@websets/wallet-x402` | x402 client |
| `signer-ows/*` | `@websets/wallet-signer-ows` | OWS signer (evm + svm + viem + balances) |
| `catalog/static.ts` | new | `StaticCatalog` from JSON |
| `catalog/http.ts` | adapted from `@websets/catalog/frames-registry-catalog.ts` | `HttpCatalog` |
| `catalog/build-invocation.ts` | `@websets/catalog/build-invocation.ts` | descriptor → ResolvedInvocation |
| `stores/memory.ts` | new | `MemoryStore` for tests |
| `stores/filesystem.ts` | new (extracted from gateway's FS store) | `FilesystemStore` default |

**Dropped from the websets code:** scoped tokens, MPP, federation in client, MCP catalog, bazaar, all gateway-specific glue.

**Exit:** `pnpm test` passes a smoke test that calls one real x402 endpoint with an OWS signer and writes a receipt. Catalog comes from a local `tools.json`.

## Stage 2 — CLI (3 days)

Single binary, three commands.

```
pay catalog list                       # list tools from default catalog
pay catalog show <tool-id>             # print one descriptor
pay tool <tool-id> --params <json>     # pay and invoke
pay wallet status                      # balance, budget, recent receipts
pay receipt show <receipt-id>          # full receipt JSON
```

Configuration: `~/.frames/pay/config.json` for default catalog URL, default signer, budget caps. CLI flags override.

**Exit:** A user can `pay tool search.exa --params '{"query":"…"}'` against a hosted catalog and get a real result.

## Stage 3 — Hosted catalog server (2 days)

Separate deploy. Cloudflare Worker, Hono, content from a git repo.

- Three routes per SPEC: `GET /catalog`, `GET /catalog/:id`, `GET /catalog?capability=…`
- KV cache, ETag, SWR
- Repo source: `catalog-content/` directory in this repo OR a separate `catalog-content` repo, served via raw.githubusercontent.com
- Webhook on the source repo invalidates KV
- One canonical deploy at `catalog.frames.ag` (or wherever)

**Exit:** `curl https://catalog.frames.ag/catalog` returns the canonical descriptors. CLI's default catalog URL points at it.

## Stage 4 — MCP server (3 days)

`pay serve` exposes the wallet over MCP. Mirrors `frame serve`.

Tools exposed:
- `discover_tool(capability?: string)` → list of descriptors
- `get_tool(tool_id: string)` → one descriptor
- `pay_for_tool(tool_id: string, params: object)` → `{ body, receipt }`
- `wallet_status()` → balance, recent receipts, budget remaining

`pay init-mcp` writes a `.mcp.json` in the cwd so any MCP client picks it up.

**Exit:** Claude Code launched in a directory with `.mcp.json` can discover tools, call them, and see receipts — no extra wiring.

## Stage 5 — Skill (1 day)

`skill/SKILL.md` with recipes for the common workflow patterns:
- "I need to search the web — find me a tool and use it"
- "Show me what I spent today"
- "Set a $10 budget for this run"

Symlink pattern: `ln -s ~/src/pay-repo/skill ~/.claude/skills/pay`. Same as `frames`.

**Exit:** A Claude Code session in a fresh directory can install the skill, init MCP, and call a paid tool in under three turns.

## Stage 6 — Second signer or second protocol (when a real consumer asks)

The plugin shape is designed for this. Examples that would slot in cleanly:
- `signer-kms` — AWS KMS-backed signer for hosted deployments
- `signer-privy` — Privy-backed signer for users coming from agentwallet
- `protocol-mpp` — resurrected MPP for channel payments

Don't pre-build. Add when one external consumer needs it.

## Stage 7+ — Scale

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
- The seller side of x402 (that's `registry`)
- The hosted custodial wallet (that's `agentwallet`)
- The dataset format (that's `frame`)
- Plugin packages for non-default signers — those ship as separate npm packages following the SPEC

## Distribution

- Library: `npm install @frames-ag/pay`
- CLI: `npm install -g @frames-ag/pay-cli` or `bunx @frames-ag/pay-cli`
- Catalog server: Cloudflare Worker, deployed via `wrangler`
- Skill: `ln -s` from a `git clone`

## Success criterion

A workflow author who wants their agent to call a paid tool can:

1. `npm i @frames-ag/pay` and call `wallet.payForTool({ toolId, params })` — under 5 lines of setup.
2. Or `pay tool <id> --params <json>` from a shell script.
3. Or call the MCP `pay_for_tool` tool from any agent harness with no code at all.

If any of those takes more than 10 minutes from zero, the design is wrong.
