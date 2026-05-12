# tick — PLAN
*Hosted runtime for frame datasets. Managed wallet + tool catalog injection. Billed via x402 / MPP, settled in USDC.*

**Name:** `tick` — domain `tick.frames.ag`, package `@frames-ag/tick`, repo location `apps/tick/`. Each op IS a tick.
**Status:** planning (research synthesized 2026-05-11; name decided 2026-05-11)
**Owner:** Luís

---

## 1. What this is

The **hosted runtime layer** for [frame](../../packages/frame) datasets. Implements [frames-cloud](../frames-cloud) Tier 3 item 15 ("Heartbeat / refresh runtime"): *a Worker that re-fetches sources, attaches fresh evidence, deprecates stale facts — and posts events back through the frames-cloud write API.*

Per the [frame protocol's anti-revisit decision (2026-04-30)](../../packages/frame/PLAN.md): *"Wallets and tool catalog access are runtime configuration, not part of the frame protocol or the curation MCP. Frames Cloud injects managed wallet/tools into the runtime on the user's behalf."* That last sentence is this product.

### What customers actually buy

Four operations, each producing append-only frame events with full provenance:

| Operation | What it does | Typical cost |
|---|---|---|
| **`curate`** | Run a full agent loop against a frame: read state → search sources → write facts → verify references → emit events | $0.50 – $2.00 |
| **`refresh`** | Re-fetch every existing fact's `source.url`, deprecate dead sources, attach new evidence where values changed | $0.10 – $0.30 |
| **`verify`** | Read-only: re-fetch sources and compare against current facts. Reports drift; does not write | $0.05 – $0.15 |
| **`discover`** | Search-only, propose candidate entities with evidence. Writes go through a human-review queue, not directly to the frame | $0.10 – $0.50 |

Customers POST `{ op, frame: <github-url>, budget: <USDC>, wallet_sig }`. The runtime:
1. Verifies the x402 payment via Faremeter
2. Resolves the frame from `frame-cloud` (GitHub-backed)
3. Opens a [pay.Wallet](../../packages/pay) with the customer's session funds
4. Connects to the frame's MCP server (or hosts one against the GitHub repo)
5. Runs the op-specific agent loop
6. Writes events with a `run_id` (frame protocol v0.0.2 hook)
7. Settles `upto` actual consumed
8. Returns the new events.ndjson lines + the run's tool log, joinable by `run_id`

### Positioning

*"The runtime that keeps your frame datasets fresh. One wallet sig, one budget, one ops verb — the runtime handles tool discovery, payment, agent loop, and event provenance. Your dataset stays evidence-backed; your wallet stays in control."*

### Wedge

- **Frames-shaped ops, not generic inference** — `curate / refresh / verify / discover` are the verbs, not "Quick/Smart/Deep tier"
- **Managed wallet + catalog injection** — the runtime brings the wallet + the deployed [catalog.frames.ag](../catalog) (5,797 ToolDescriptors federated across x402 Bazaar, MPP, and Frames Registry). Customer doesn't assemble.
- **Wallet IS the identity** — x402 / MPP signature, no API keys, no signup
- **`run_id` correlates everything** — every fact in the frame links back to a tool log; receipts are auditable from the dataset itself
- **Dual distribution** — same package runs locally via `frame run <op>` (CLI) or remotely via the hosted runtime (HTTP). Migration is one env-var swap.
- **Callable from any harness** — the runtime is exposed as both an MCP server and a SKILL package (`frames-engineering/skills --skill runtime`). opencode, Claude Code, Codex CLI, Cursor — any MCP-aware harness — calls `runtime.curate / refresh / verify / discover` as normal tools. We own the agent loop inside the service; external harnesses see four tools.

### Defensibility

The agent loop is opinionated for frame-shaped work (verify-in-loop, evidence-first, bulk-write events, deprecate-don't-delete). Generic agent harnesses (opencode, Claude Code) can do this but require careful prompt engineering. The runtime bakes the discipline in.

---

## 2. Threat timing — sharpened by vertical positioning

The competitor list looks different once we're not in the generic inference market:

| Threat | Likelihood (12mo) | Why it doesn't kill us |
|--------|--------------------|--------------------------|
| **OpenRouter** ships generic x402 + tools marketplace | ~60% | Different product. Generic inference, no dataset semantics. Our customer doesn't migrate. |
| **Exa Websets** adds wallet-native flows | ~30% | Closest neighbor; structured dataset from web search. But proprietary schema, no events.ndjson, no git-backed provenance. |
| **Perplexity Spaces** opens an API | ~20% | Consumer-facing, no programmatic dataset semantics. |
| **Coinbase reference x402 agent** on Agentic.Market | ~40% | Generic. Wouldn't ship verticals. |
| **Frame itself ships a runtime CLI** (`frame run curate`) | ~80% | This is **us**, just the OSS path. Hosted version is the same code with managed wallet + scheduling. |

**Implication:** the OpenRouter clock is mostly off. The new clock is **how quickly we ship the curate/refresh/verify ops with quality**, before customers reach for opencode + agentwallet + their own scripts and decide they don't need us. Existing usage (frames-examples, blindspot.news) is already pre-product fit — they do exactly this DIY today.

---

## 3. Architecture

```
[customer]                                        [their frame]
   │  POST /run                                      ↑
   │  {op, frame: github.com/u/r, budget, sig}       │ events written back
   ▼                                                 │ via frame MCP
[Worker entry]                                       │
   │  • Faremeter facilitator (sibling CF Container) │
   │    verifies x402 `upto` or opens MPP session    │
   │  • derives runId, sessionId                     │
   ▼                                                 │
[RunSession DO]  one per /run call                   │
   │  extends `agents` SDK Agent class               │
   │  SQLite state: runId, op, frame_url, budget,    │
   │                wallet, history, tool_log        │
   │                                                 │
   │  agent loop (op-specific):                      │
   │   ├── frame MCP client ──────────────────────HTTP───→ frame serve --transport http
   │   │    (read state via `query`,                      (against the GitHub repo,
   │   │     write via bulk `set_facts` /                  hosted by frames-cloud OR
   │   │     `add_entity_with_facts` /                     spawned locally by harness)
   │   │     `deprecate_fact` / `attach_evidence`)
   │   │
   │   ├── catalog MCP tools (3 surfaces only):
   │   │    catalog.search → catalog.frames.ag/catalog?capability=...
   │   │    catalog.get    → catalog.frames.ag/tools/<id>
   │   │    tool.invoke    → resolves descriptor, calls via pay.Wallet (Faremeter)
   │   │
   │   ├── AI Gateway (BYOK aliases, Dynamic Routing, Custom Costs)
   │   │    routes by agent role (title→Haiku, build/explore→Sonnet)
   │   │
   │   └── sandbox (Cloudflare Sandboxes) — only for code/scrape ops
   │
   │  every event written to the frame carries run_id
   │  every paid call recorded in DO tool_log
   │  budget decrements on each return; halt at ceiling
   │
   └─ on stop: settle `upto` actual; emit final run record
   ▼
[Queue] → receipt to D1, transcript to R2; joinable by run_id
```

**Built on:**
- [`agents`](https://github.com/cloudflare/agents) SDK (v0.12+) — DO scaffolding, scheduling, MCP host, streaming
- [`@cloudflare/think`](https://blog.cloudflare.com/project-think/) primitives — sub-agents for title/build/explore routing; persistent sessions for MPP multi-turn; sandboxed code exec via the execution ladder
- [`@frames-ag/frame`](../../packages/frame) — frame MCP client (consumes `frame serve --transport http`)
- [`pay`](../../packages/pay) — `Wallet` + `HttpCatalog` + `FederatedCatalog`, wrapping Faremeter under the hood
- [Faremeter](https://github.com/faremeter/faremeter) — protocol layer (self-hosted facilitator on CF Containers, see §6)

**State placement:**
- Run state (budget, tool log, history) → DO SQLite
- Sandbox FS → ephemeral (only for code/scrape ops); R2 mount for user-delivered artifacts
- Receipts + run metadata → D1, keyed by `run_id`
- Dataset events → frame events.ndjson via frame MCP write tools (NOT held in our DO; the frame owns its state)

**Wallet model — v1:** self-custody, env-loaded keys. One Solana keypair + one EVM private key, signed locally via `@faremeter/wallet-solana` and `@faremeter/wallet-evm`. The EVM key serves both Base (x402) and Tempo (MPP via [`@frames-ag/payment-tempo`](../../packages/payment-tempo)). No third-party custody dependency.

---

## 3a. Sandbox integration model

**Principle unchanged:** agent loop in DO; sandbox is a compute appendix for code/scrape ops. Plus a sharper rule from the codebase study:

**Dataset state lives in `events.ndjson` (in the customer's git repo), NOT in our sandbox or DO.** The sandbox is transient compute; R2 only holds artifacts produced for the customer (downloadable outputs, generated images). The runtime never persists dataset state — that's the frame's job.

### Sandbox usage by operation

| Op | Sandbox needed? | Why |
|---|---|---|
| `curate` | Only if a tool returns scrapable artifacts that need transformation (PDFs, CSVs) | Mostly LLM + tool dispatch from DO |
| `refresh` | No | Pure HTTP-fetch + comparison loop |
| `verify` | No | Read-only; same as refresh |
| `discover` | Optional | Sometimes useful for parsing complex source documents |

### What's in / out of the sandbox

(Unchanged from prior plan; sandbox holds code interpreter + filesystem + egress proxy. DO holds wallet, budget, history, frame MCP client.)

### Sandbox lifecycle

- Spawn lazily on first code-exec tool call in a run (not pre-warm)
- Destroy on run completion (no cross-run state)
- For multi-turn MPP sessions: snapshot on idle; restore on next turn

### Failure handling

- Sandbox crash → tool failure surfaced to model; budget for that segment not settled
- Snapshot restore failure → cold-start fresh
- Code-exec cost runaway → DO budget guard caps; per-call settle on `upto` settles only what was consumed

---

## 3b. Distribution & integration modes

The runtime builds the dataset. Events flow back into the customer's git repo. Three modes for getting them there, listed by shipping order:

### Mode 1 — Customer owns the commits (default, ship first)

Drop-in replacement for today's frames-examples GitHub Actions pattern. The CI calls the runtime via CLI; events are written to the local working tree; the customer's bot commits and pushes.

```yaml
# .github/workflows/tick.yml (customer's repo, unchanged shape)
- checkout
- run: npx @frames-ag/tick curate datasets/foo --budget 1.50
    # ↳ CLI calls our hosted service with wallet sig
    # ↳ Returns events.ndjson lines as response body
    # ↳ CLI appends them to datasets/foo/events.ndjson
- run: frame verify datasets/foo
- run: frame project datasets/foo
- run: git commit -am "tick(foo): ..." && git push
```

**Migration for frames-examples / blindspot.news:** swap `opencode run "$(cat prompt.md)"` for `npx @frames-ag/tick curate <dataset>`. One env var (`TICK_API_KEY`), one command change. No new GitHub permissions, no trust escalation. Works on any repo.

### Mode 2 — Hosted writes back via GitHub OAuth (post-alpha)

Customer one-time installs a GitHub App. Our runtime then runs ticks on its own schedule and commits events directly via the GitHub Contents API. Customer doesn't need CI at all.

- Schedule via `frames.yml` in repo root or webhook
- Batches a 50-fact run into 1 commit (matches [frames-cloud Tier 2 item 7](../frames-cloud/PLAN.md))
- Commit message: `frames: <op> via <wallet> ($X spent, run_id=<id>)`
- Required GitHub App scopes: `contents:write` on selected repos; no org-level access

**Implements [frames-cloud Tier 2 item 7](../frames-cloud/PLAN.md) (Write API + GitHub OAuth).** Higher trust — we have write access — but enables true hosted mode.

### Mode 3 — Pull-from-runtime API (not on roadmap)

Customer fetches events from `/runs/<run_id>/events.ndjson` and applies locally. Decouples our durability from customer's repo but splits source-of-truth ambiguously. **Skip unless explicitly requested.**

### Where events live

| Mode | Source of truth | Who commits | Available |
|---|---|---|---|
| 1 (CLI) | Customer's git repo | Customer | Day 1 — drop-in for frames-examples |
| 2 (Hosted) | Customer's git repo | Frames Runtime (via GitHub App) | Post-alpha / v0.1 |
| 3 (Pull) | Our D1 + customer pulls | Customer | Not on roadmap |

In all shipping modes, events end up in the customer's git, preserving the frame protocol's invariant: `events.ndjson` is the source of truth.

### The `run_id` join

Both shipping modes write events with `run_id`. The receipt at `GET /runs/<run_id>` is queryable by wallet sig (free, SIWX-gated). Anyone reading the dataset can join `events.ndjson` to the run log via `run_id` — see which paid tool produced each source URL, what it cost, when. This is what makes "evidence-tracked" verifiable, not just claimed.

---

## 3c. External harness integration

The runtime owns its internal agent loop — but the **service** is callable from any external agent harness (opencode, Claude Code, Codex CLI, Cursor, anything MCP-aware). Two surfaces:

### MCP server

Customers add to their `.mcp.json`:

```json
{
  "mcpServers": {
    "frames-runtime": {
      "command": "npx",
      "args": ["-y", "@frames-ag/tick", "mcp"],
      "env": { "TICK_API_KEY": "..." }
    }
  }
}
```

The MCP server exposes four tools matching our ops:

- `runtime.curate({ frame, budget, params? })` → events.ndjson lines + run_id + cost
- `runtime.refresh({ frame, budget, fields? })` → same shape
- `runtime.verify({ frame, budget, scope? })` → drift report + run_id
- `runtime.discover({ frame, budget, capability_hints? })` → candidate entities for review

Each tool is a **thin proxy**: it accepts args, calls our hosted HTTP endpoint with the customer's wallet sig, returns the structured result. The actual agent loop runs on our infrastructure; the harness sees normal tool calls.

This is how opencode running in GitHub Actions calls the runtime as one tool among many — same way it calls Exa search or the frame MCP today.

### SKILL package

Following the `frames-engineering/skills` convention used by frames-examples:

```bash
npx skills add https://github.com/frames-engineering/skills --skill runtime -y
```

Drops a `SKILL.md` into the harness with:
- Prompt-level documentation of the four ops
- Examples of when to use `curate` vs `refresh` vs `verify`
- Cost guidance (default budgets, when to override)
- Auth setup (`TICK_API_KEY` env var)

The skill makes the runtime discoverable to agents that don't load MCP servers — a more lightweight integration for prompt-based harnesses.

### Both surfaces in v1

MCP is for programmatic use; SKILL is for prompt-time discovery. Ship both at public alpha. The SKILL points at the MCP server for actual invocation; users who only install the SKILL still get working calls via curl (with credentials read from the skill's documented env vars), matching the existing `agentwallet` / `registry` skill patterns.

### Identity reuse

The same wallet that signs `/run` directly also authenticates via the MCP server proxy. No separate API keys — the `TICK_API_KEY` env var is the wallet's session token (SIWX-derived). Customers can rotate the session without rotating the wallet.

---

## 4. Operations & pricing

**Drop fixed Quick/Smart/Deep tiers.** Real-workload analysis (frames-examples + blindspot.news logs, 2026-05-05 / 2026-05-11) shows 5× variance in LLM calls and 130× variance in tool calls across the same harness. Fixed tiers misprice the work.

Replace with **op + customer-set `upto` budget**:

```
POST /run
{
  "op": "curate" | "refresh" | "verify" | "discover",
  "frame": "https://github.com/<user>/<repo>[/<path>]",
  "budget": "1.50",          // USDC; the upto ceiling
  "wallet_sig": "...",        // x402 signature
  "params"?: { ... }          // op-specific (e.g., refresh: which fields)
}
```

Suggested budget defaults per op (from real-workload data):

| Op | Default budget | P50 actual settle | P95 actual settle |
|---|---|---|---|
| `curate` | $1.50 | $0.50 | $1.80 |
| `refresh` | $0.30 | $0.10 | $0.25 |
| `verify` | $0.15 | $0.05 | $0.12 |
| `discover` | $0.50 | $0.15 | $0.45 |

Customer pays only what's consumed (`upto` settle). Defaults are recommendations; sophisticated customers can set lower (with risk of premature termination) or higher (no cost, just headroom).

**No "tier price markup" model.** Margin comes from the spread between catalog tool prices (via [`ToolDescriptor.payment.price_hint`](../../packages/pay/SPEC.md)) and what we charge for the op. Roughly 20–40% gross margin per call at default budgets.

---

## 5. Pricing model decision

**Decision: customer-set `upto` budget per op, with ToolDescriptor.payment as authoritative pricing.**

### Mode A — x402 `upto` (default for `/run`)
- Customer authorizes `upto budget` USDC; runtime settles actual consumed amount on completion
- Best for: `verify`, `refresh`, and most `curate` ops (single agent run, no need for multi-turn)
- Eliminates P95 tail risk; customer pays only what they used

### Mode B — MPP session (default for `/session`)
- Pre-authorized cap; charges stream per-tool/per-turn; settle on close
- Best for: long `curate` runs that span multiple model turns or that need a persistent sandbox across turns
- v1 MPP: **Solana** via Faremeter's `charge` intent + **Tempo** via [`@frames-ag/payment-tempo`](../../packages/payment-tempo) (in-monorepo). No Stripe dependency in tick's critical path. `@faremeter/fetch`'s `wrap()` auto-routes between v1/v2 x402 and MPP based on the seller's 402 response.

### Why ToolDescriptor.payment is authoritative

Pay's spec: `descriptor.payment.price_hint` is advisory; **the seller's 402 challenge is authoritative**. Our runtime doesn't maintain its own tool price database — every paid call resolves the descriptor at invocation time, presents the 402 challenge, settles per the seller's response. This means:

- No price-drift risk (our runtime can't be stale vs. catalog)
- Federation works — customers can point at private catalog forks for internal tools
- Catalog updates (new tools, price changes, deprecations) propagate immediately

### Launch matrix — what's actually shippable in v1

| Rail | x402 (`/run`) | MPP (`/session`) |
|------|----------------|-------------------|
| **Solana** | ✅ Faremeter (`exact`, `flex`) | ✅ Faremeter (`charge` intent) |
| **Base / EVM** | ✅ Faremeter (EIP-3009) | ❌ no faremeter handler; less critical — x402 covers EVM cleanly |
| **Tempo** | ❌ not on Tempo | ✅ **`@frames-ag/payment-tempo`** (in monorepo; wraps `mppx`) |
| **Polygon / Monad / Skale** | ✅ Faremeter (EIP-3009) | ❌ requires upstream contribution |

**Stripe MPP is not in v1's critical path anywhere.** Customers wanting MPP get Solana (Faremeter) or Tempo (our package). EVM MPP gap is post-alpha territory and matters less because Base x402 is the natural EVM payment path.

`@frames-ag/payment-tempo` ships as a Faremeter `MPPPaymentHandler`. Once it sees real-world validation against a Tempo MPP seller, the path is to PR it upstream into `faremeter/faremeter` as `packages/payment-tempo` (see [`packages/payment-tempo/UPSTREAM_PR.md`](../../packages/payment-tempo/UPSTREAM_PR.md)).

---

## 6. Payment plumbing

### Inbound — facilitator on Cloudflare Containers

(Unchanged from prior plan.) **Self-hosted [Faremeter](https://github.com/faremeter/faremeter) on CF Containers.** v1 deploys upstream Faremeter `apps/facilitator` (Hono + `@hono/node-server`) in a Dockerfile, fronted by a thin Worker. Region-pinned alongside the runtime Worker; verify hop is 5–15ms colo-local. Coinbase CDP wired as failover.

Two paths for the facilitator deployment:
1. **CF Containers** (v1) — zero-mod Faremeter; ship now
2. **Workers-native fork** (post-alpha) — swap `@hono/node-server` for native Workers fetch; sub-millisecond cold start; upstream the adapter

### Outbound — `@faremeter/fetch wrap()` with self-custody keys

Tick holds its own keys. No agentwallet proxy, no Coinbase Agentic, no Stripe. Two private keys in Worker secrets sign every outbound paid call directly.

**Env-var picture (only what's needed):**

| Secret | Purpose | Produced by |
|---|---|---|
| `SOLANA_OUTBOUND_KEYPAIR_JSON` | 64-byte JSON array; signs Solana x402 + Solana MPP charge | `apps/tick-facilitator/scripts/gen-solana-keypair.ts` |
| `EVM_OUTBOUND_PRIVATE_KEY` | `0x`-hex; signs Base x402 (EIP-3009) AND Tempo MPP charge (same EVM key, two chains) | `apps/tick-facilitator/scripts/gen-evm-keypair.ts` |
| `SOLANA_RPC_URL` | Mainnet RPC for tx broadcast | provider (Helius / Triton / public) |
| `EVM_RPC_URLS` | JSON map per chain | provider |

The Worker boots one `paidFetch` per region by composing handlers:

```ts
// apps/tick/src/wallet.ts (sketch)
import { wrap } from "@faremeter/fetch";
import { createLocalWallet as createSolanaWallet } from "@faremeter/wallet-solana";
import { createLocalWallet as createEvmWallet } from "@faremeter/wallet-evm";
import { createFacilitatorClientHandler as createEvmExact } from "@faremeter/payment-evm/exact";
import { createFacilitatorClientHandler as createSolanaExact } from "@faremeter/payment-solana/exact";
import { createMPPClient as createSolanaCharge } from "@faremeter/payment-solana/charge";
import { createMPPTempoChargeClient } from "@frames-ag/payment-tempo";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export async function bootWallets(env: Bindings) {
  const solanaSecretKey = Uint8Array.from(JSON.parse(env.SOLANA_OUTBOUND_KEYPAIR_JSON));
  const solanaWallet = await createSolanaWallet("mainnet-beta", solanaSecretKey);
  const evmWallet = await createEvmWallet(base, env.EVM_OUTBOUND_PRIVATE_KEY as `0x${string}`);
  const tempoAccount = privateKeyToAccount(env.EVM_OUTBOUND_PRIVATE_KEY as `0x${string}`);

  const paidFetch = wrap(fetch, {
    handlers: [
      await createEvmExact(base, evmWallet, "USDC"),
      // ... createSolanaExact with rpc + USDC mint
    ],
    mppHandlers: [
      // ... createSolanaCharge for MPP-on-Solana
      createMPPTempoChargeClient({ account: tempoAccount }),
    ],
  });

  return { paidFetch, solanaWallet, evmWallet, tempoAccount };
}
```

`@faremeter/fetch`'s `wrap()` does the negotiation:

1. Sends the request
2. On 402: tries MPP first (if `mppHandlers` configured and the seller's `WWW-Authenticate` matches), then falls through to x402
3. x402 path auto-detects v1 vs v2 from the response shape and sets `X-PAYMENT` or `V2-PAYMENT` accordingly
4. Retries with backoff (default 2 retries)

**Tick wraps `wrap()`** with three concerns above its pay grade:

- Pre-check budget against the catalog descriptor's `price_hint` before signing
- Read settled cost from `X-PAYMENT-RESPONSE-*` headers; record in `tool_calls` row + emit `tool.invoked` event
- Catalog discovery (`catalog.search` → pick descriptor → call) lives in the agent loop, one level up

### Tool surface — catalog-mediated discovery

**Drop the curated palette.** The agent gets three MCP tools at boot:

```
catalog.search({ capability?, query?, cursor?, limit? }) → ToolDescriptor[]
catalog.get(descriptor_id)                                → ToolDescriptor
tool.invoke(descriptor_id, args)                          → { result, cost, source, retrieved_at }
```

That's the entire tool surface. The 5,797 descriptors at [catalog.frames.ag](../catalog) (mirrored from x402 Bazaar, MPP directory, Frames Registry) are addressable by capability tag. Model picks what it needs at runtime; the runtime resolves, pays, records, returns.

**Why this is cleaner than a curated palette:**
- Context savings: ~3 tools at boot vs. ~80 MCP tools loaded by opencode today
- Federation built-in: customer points at their own catalog fork for private tools
- Catalog updates propagate instantly — no service redeploy
- Provenance baked in: every `tool.invoke` response wraps the result with `{ source_url, retrieved_at, cost }`
- The catalog IS the moat — already deployed, content-addressed, federated

**Free APIs are first-class.** Many catalog descriptors have `payment.price_hint: "0"` (GitHub API, Polymarket public-search, vendor docs). These flow through the same `tool.invoke` path; no separate code path for free tools.

### Identity (unified across both protocols)

- Wallet address from payment payload = identity
- SIWX (CAIP-122) for cross-rail identity — same wallet works for x402 and MPP
- Free SIWX-gated reads: `/status`, `/history`, `/runs/<run_id>`, `/balance`
- Per-wallet rate limits

### Failure handling

- **x402:** upstream tool fails → don't settle that portion; under `upto`, settle for lower bound. Server crash after settle → idempotent `run_id` → settled-amount table; refund via queued release.
- **MPP Solana (Faremeter):** intent has explicit authorization; partial-completion = settle for streamed amount, release the rest. `charge` intent is idempotent by intent_id.
- **MPP Tempo (`@frames-ag/payment-tempo`):** mppx-mediated `tempo.charge` intent; idempotent by intent_id. Same partial-completion semantics as Solana.
- Cross-protocol: idempotent receipts in D1 keyed by `run_id`.

---

## 7. Agent loop design

### Loop shape

- **Tool-use loop** (function calling), not ReAct. Override `@cloudflare/think`'s default ReAct-like loop.
- **Verify-in-loop:** before settling, the loop validates referential soundness of any frame events it wrote (matches `frame verify` semantics; if a fact references a deprecated entity, abort and emit error event).
- **Bulk writes:** prefer `set_facts` and `add_entity_with_facts` (frame MCP v0.0.1 tools 8/9) over per-field writes. One MCP call per entity per turn.
- **Streaming:** WebSocket from client to DO. AI Gateway SSE → WebSocket frames.

### Sub-agent routing (via `@cloudflare/think` facets)

| Sub-agent | Model | Used for |
|---|---|---|
| `title` | Haiku 4.5 | Session naming, short summaries |
| `build` | Sonnet 4.6 | Main agent loop, tool dispatch, writes to frame |
| `explore` | Sonnet 4.6 (or Haiku for cost) | Deep-dives into individual sources |

This preserves opencode's existing pattern (observed in real runs). Customers using opencode locally see no behavior change when migrating; the runtime just routes the same way.

### Budget enforcement

Two-layer:
- (a) DO-local decrement on each `tool.invoke` return — fast path
- (b) AI Gateway Custom Costs reconciled via Queue worker writing to D1 — audit path

Trust (b) on divergence.

### `run_id` correlation (frame protocol v0.0.2)

**Every event the runtime writes to a frame carries a `run_id`** (frame's queued v0.0.2 event-envelope addition):

```json
{
  "id": "uuid-v4",
  "ts": "...",
  "type": "fact.set",
  "agent": "frames-runtime:<wallet-address>",
  "run_id": "run_<id>",
  "payload": { ... }
}
```

The runtime's D1 receipt is keyed by `run_id` and stores:
- All paid tool calls in the run (descriptor_id, args hash, cost, source, retrieved_at)
- All LLM turns (model, tokens, cost)
- Total settled amount
- Wall-clock duration

**The dataset and the receipt are joinable by anyone with read access.** Customers can audit "for this fact, which tool calls produced the source URL, at what cost, when?" by joining frame events to the run log.

This is the receipt UX problem solved by an already-planned protocol field. Not invented; just adopted.

### `agent` field convention

Format: `frames-runtime:<wallet-address>` (e.g., `frames-runtime:0xa1b2...`). Matches the frame protocol's `<kind>:<identifier>` pattern. Provides per-wallet attribution in git history without exposing other PII.

---

## 8. Risks & open questions

### Architecture
- **DO 5-min CPU ceiling** per message reset on streaming. Push CPU-heavy work to Sandbox; the DO coordinates.
- **Sandbox cold start ~30s.** Only `curate` with code-exec needs it; lazy-spawn on first tool call.
- **AI Gateway BYOK quotas** — per-key, not per-op. Configure Dynamic Routing failover across providers; rate-limit per wallet.

### Economics
- **Variance is the real risk.** P95 cost varies wildly even within one op (e.g., `curate` on a fresh dataset vs. a mature one). `upto` mitigates customer-side exposure; we still need provider-side budget caps for our own protection.
- **Catalog descriptor staleness.** If a seller deprecates a tool but the catalog hasn't refreshed, a `tool.invoke` fails late. Mitigate with catalog `/webhooks/invalidate` integration and graceful fallback to alternate descriptors with the same `capabilities` tag.

### Protocol
- **Faremeter v0.21 is pre-1.0.** Pin a known release via submodule; gate upgrades through CI.
- **EVM MPP gap.** Faremeter has Solana-only MPP today. Tick covers **Tempo** MPP via [`@frames-ag/payment-tempo`](../../packages/payment-tempo) (in-monorepo). MPP on Base/Polygon/Monad/Skale is a post-alpha contribution to Faremeter; matters less because x402 covers those chains.
- **Regulatory.** Operator wallet receives USDC and pays upstream. Counsel review at ~$50K total volume; MSB consideration above ~$1M/yr.

### Frame integration
- **`run_id` requires frame v0.0.2.** Currently queued, not shipped. Either contribute the field upstream (small PR) or ship interim receipts keyed by `(wallet, ts)` instead.
- **Bulk-write event** is also queued for v0.0.2 ("setting 5 fields creates 5 events"). Without it, our LLM-call count is higher than necessary for entity creation. Upstream contribution would help.
- **`frame serve --transport http`** must be reachable from our runtime. For frames-cloud-hosted frames, this is natural (we host both sides). For self-hosted frames, customers expose their `frame serve` somewhere addressable, OR we host a read-only mirror via the GitHub-resolver path (Tier 1 of frames-cloud).

### Product
- **Variable price display.** "Up to $1.50, typical $0.50" is honest but harder to communicate than flat. Mitigation: receipt UX shows per-line-item with `run_id` join; customers can audit any single run.
- **Frames-examples / blindspot.news migration.** They currently pay OpenRouter + agentwallet separately. Our service unifies both behind one wallet sig. Migration is one env var, but we should provide a CLI sub-command (`frame run --hosted curate`) that proves the migration is one-line.

---

## 9. Build plan — status as of 2026-05-12

### v0.0.2 (2026-05-12) — v1 hosted gating + npm pre-publish

- ✅ **Decision: v1 = CLI + hosted, no facilitator.** Self-hosted Faremeter (`apps/tick-facilitator/`) is Phase B. The hosted endpoint ships with an explicit agent allowlist (`TICK_ALLOWED_AGENTS`) that's **closed by default** — fresh deploys 403 every call until configured.
- ✅ `src/allowlist.ts` + `/run` middleware + `/health.hosted` surface + 14 new tests (57/57 green)
- ✅ MIT LICENSE (monorepo root + `apps/tick/`); license/repo/keywords/engines metadata in `package.json`
- ✅ npm tarball trimmed: 341.6 kB → 119.8 kB packed, 1.7 MB → 564.4 kB unpacked. Validated end-to-end by extracting the packed tarball and running `node dist/cli.js --help` + MCP `tools/list`.
- ✅ `DEPLOY.md` rewritten — Phase A is no-facilitator + allowlist + CLI publish; Phase B documents BOTH paths (CDP + self-host)
- ✅ MCP server descriptions un-stubbed; version synced to 0.0.2
- ✅ README install section, allowlist callout in secrets, facilitator demoted to commented-out Phase B line
- ✅ **Investigated CDP x402 API shape** (2026-05-12). Found: our `verifyInboundX402` / `settleX402` use a Faremeter-style custom shape; x402 v2 spec (what CDP exposes) wants `{ x402Version, paymentPayload, paymentRequirements }`. **CDP integration is NOT a config flip — adapter or v2-native rewrite required.** Documented in `src/payment/x402.ts` header + `STRATEGY.md` Phase B finding.

### v0.0.1 (2026-05-11) — hardening pass

[See CHANGELOG.md v0.0.1 for line items: x402 verify auto-strict, `settleX402` wired, ed25519 signed receipts, progressive per-event SSE, batched D1 writes, hardened `DELETE /history`, GDPR purge, idempotency, audit-signer + curate tests, DEPLOY.md, MIGRATION.md, STRATEGY.md.]

### v0.0.0 (2026-05-11) — initial sprint

[Items below were the original week-by-week plan; what shipped is captured by ✅ markers.]



Original 5-week plan; most of weeks 1–5 code-side work shipped in a single intensive session. **Code-only items are functionally complete.** External-auth items (deploy, wallets, real-money validation) are next-step work for the operator.

### Week 1 — Facilitator + Worker scaffold + first round-trip ✅ CODE COMPLETE

- ✅ `apps/tick-facilitator/` scaffolded: Dockerfile wrapping upstream Faremeter (v0.21.0 pinned), CF Containers binding, thin Worker proxy, env-config patch verified against fresh clone
- ✅ `apps/tick/` scaffolded: Hono app on `agents` SDK base, POST `/run` validates op + frame URL
- ✅ D1 schema: `runs` / `tool_calls` / `events` (3 tables + 8 indexes), live local + remote (LIS colo), CHECK constraints validated by insert tests
- ✅ Wallet keygen scripts (`gen:solana`, `gen:evm`) in `apps/tick-facilitator/scripts/` — pipe-to-`wrangler secret put`
- ⏳ **Deploy facilitator** — external auth: needs wallet funding + `wrangler secret put` × 4 + `wrangler deploy`
- ✅ **x402 verify on inbound** — `src/payment/x402.ts` (verifyInboundX402 + settleX402); wired into POST `/run` before op dispatch. Optional mode: when `FACILITATOR_URL` unset OR no `Payment` / `Payment-Signature` header present, logs warning and proceeds (dev). When header present, returns 401 on facilitator rejection. Verified payer overrides IP-hashed `agent` identity and populates `payment_protocol` / `payment_network` on the run row.
- ✅ **Receipt audit signing** — `src/payment/audit-signer.ts` ed25519 over canonical JSON of receipt fields (PKCS8-wrapped seed loaded once per isolate from `AUDIT_PRIVATE_KEY`). `tool.invoked` events in `catalog-dispatch.ts` carry `signature` instead of `""`. `/health` surfaces `audit_key_configured`.

### Week 2 — `verify` and `refresh` ops live ✅ CODE COMPLETE

- ✅ `src/wallet.ts` `bootWallets()` composes Solana + EVM + Tempo handlers via `wrap()`; self-custody, env-loaded
- ✅ `src/frame-client.ts` — typed wrapper for frames-cloud REST (`/api/v1/<user>/<repo>/entities`, etc.) with ETag caching + iterateEntities
- ✅ `src/llm/client.ts` — LLM client with **CF AI Gateway BYOK** routing (Stripe-style); passthrough fallback for dev
- ✅ `src/ops/verify.ts` — full implementation: iterate entities → refetch → classify drift (source_dead / value_drift / excerpt_missing / source_redirect / verified)
- ✅ `src/ops/refresh.ts` — verify iteration + emits `fact.deprecated` / `evidence.attached`; uses fact_ids surfaced by frames-cloud
- ✅ `src/ops/refetcher.ts` (free) + `src/ops/paid-refetcher.ts` (uses `paidFetch`) — same Refetcher interface, swap via `pickRefetcher(env)` in handler
- ✅ DO-local budget decrement; AI Gateway Custom Costs reconciliation deferred to operator runtime tuning
- ✅ **Live-validated end-to-end** against `microchipgnu/ai-agent-wallets-eu` via local frames-cloud: 13 entities, 65 fields, 36 verified, 29 drifts

### Week 3 — `curate` and `discover` ops ✅ CODE COMPLETE

- ✅ `src/ops/curate.ts` — full agent loop with 9 tools: query + 4 frame writes + 3 catalog tools + web_fetch
- ✅ `src/ops/discover.ts` — search-only; 7-tool palette (query + 3 catalog + web_fetch + propose_entity, no frame mutations); candidates land in `report.candidates[]`
- ✅ Catalog-mediated discovery: `src/catalog/client.ts` + `src/ops/catalog-dispatch.ts` (shared across curate + discover) — `catalog_search`, `catalog_get`, `tool_invoke` against catalog.frames.ag (5,797 descriptors)
- ✅ Pre-checks `descriptor.payment.price_hint` against remaining budget before signing
- ✅ Server-side spam filter: tools with `quality.l30DaysTotalCalls === 0` filtered out
- ⏳ **Sub-agent routing via `@cloudflare/think` facets** — `agent: title|build|explore` hint currently picks the model (Haiku vs Sonnet); real sub-agent spawning is a v0.1 architectural upgrade
- ⏳ **Sandbox integration for code-exec in curate** — not in scope for v1; week-4 territory if it ships

### Week 4 — MPP sessions + hardening (mixed)

- ⏳ `/session` endpoint for MPP multi-turn — not built; v1 ships `/run` only (single-shot)
- ✅ Per-IP rate limits — `src/rate-limit.ts` with D1-backed sliding window (60s + 3600s), Hono middleware before `/run`, returns 429 with `Retry-After` + `X-RateLimit-*` headers, fail-open on DB errors. Identity flips to wallet address when SIWX lands.
- ⏳ Per-tool MCP scoping — not yet; catalog query is global per call
- ⏳ End-to-end Tempo MPP validation — `packages/payment-tempo/` is wired into `bootWallets`, but no real Tempo seller available for live validation

### Week 5 — External surfaces ✅ CODE COMPLETE

- ✅ **MCP server export** — `src/cli.ts` + `src/mcp.ts`; `dist/cli.js` (482 KB) built via `scripts/build.ts` with Node shebang; validated by piping `tools/list` to plain `node`
- ✅ **SKILL package** at `apps/tick/skill/{SKILL.md, skill.json}` matching `frames-engineering/skills` format
- ✅ **SIWX read endpoints** — `/runs/:id` returns D1-backed receipt (run + events + tool_log), `/history?address=<wallet>` lists runs by agent (TODO: real SIWX signature gate), `/balance` surfaces wallet config
- ✅ Receipt UX: events.ndjson-shape per `event_id` + `tool_calls` ordered by seq, joinable to customer's frame by `run_id`
- ✅ Local CLI: `bun src/cli.ts <op> <frame>` works today; npm-published `npx -y @frames-ag/tick` works after `bun run build` + publish
- ⏳ **Public landing page + docs** — out of scope for code; operator-side work
- ⏳ **frames-examples migration** — pending operator action: swap `OPENROUTER_API_KEY` → `TICK_API_KEY` in their `.github/workflows/tick.yml` and `opencode run` → `npx -y @frames-ag/tick curate`

### Post-alpha upstream contributions

- ✅ **frame protocol v0.2.0** — done in monorepo's `packages/frame` (run_id + facts.set_many in PROTOCOL.md + types.ts + projector.ts + CHANGELOG.md; typecheck clean). Upstream PR to canonical npm release queued.
- ⏳ **Upstream `@frames-ag/payment-tempo` to faremeter** — package in monorepo as `packages/payment-tempo`; UPSTREAM_PR.md drafted. Pending real-world validation against a Tempo MPP seller.
- ⏳ **Faremeter EVM MPP** — downgraded priority (Tempo covers via mppx).
- ⏳ **Faremeter Workers-native adapter** — ~1 day; sub-millisecond cold start. Post-alpha.

### Post-alpha upstream contributions

- **frame protocol v0.2.0** — done in monorepo's `packages/frame` (run_id + facts.set_many shipped 2026-05-11). Upstream PR to the canonical `@frames-ag/frame` npm release queued.
- **Upstream `@frames-ag/payment-tempo` to faremeter** — package was built faremeter-shaped on purpose. Once we have real-world validation against a Tempo MPP seller (week 4 exit), PR it into `faremeter/faremeter` as `packages/payment-tempo`. See [`packages/payment-tempo/UPSTREAM_PR.md`](../../packages/payment-tempo/UPSTREAM_PR.md).
- **Faremeter EVM MPP** — `charge` intent for Base/Polygon/Monad/Skale. Less urgent than initially scoped (Tempo covers the MPP-on-EVM-chain use case via mppx). Track for whenever a specific customer needs MPP-on-Base.
- **Faremeter Workers-native adapter** — swap `@hono/node-server` for native Workers fetch. ~1 day. Sub-millisecond cold start.

**Out of scope for alpha:** Polygon/Monad/Skale enablement, per-session sub-wallets, multi-region wallet, fine-tuning, custom tool registration.

---

## 10. Open decisions

1. ~~**Product name.**~~ ✅ Decided 2026-05-11: **`tick`**. Domain `tick.frames.ag`, package `@frames-ag/tick`, env var `TICK_API_KEY`. Repo folder rename `apps/inference/` → `apps/tick/` pending.

2. ~~**Frame v0.0.2 timing.**~~ ✅ Decided 2026-05-11: contribute `run_id` + `facts.set_many` upstream in **week 1**, alongside facilitator scaffolding. ~½ day work. Unblocks the cleaner audit story from day one.

3. ~~**EVM MPP at launch.**~~ ✅ Decided 2026-05-11 (revised same day): **no Stripe MPP in v1 at all.** [`@frames-ag/payment-tempo`](../../packages/payment-tempo) (in monorepo) provides MPP on Tempo via `mppx` — the canonical Stripe-L2 MPP rail without Stripe in tick's critical path. EVM-chain MPP (Base/Polygon/Monad/Skale) remains a post-alpha Faremeter contribution but is downgraded in priority because x402 covers those chains cleanly.

4. ~~**Self-hosted frame access.**~~ ✅ Decided 2026-05-11: **(b) read mirror + (c) Mode 1 write.** Reads go through frames-cloud's GitHub-resolver (`frames-cloud.workers.dev/v1/<user>/<repo>`) which works on any public GitHub repo with `schema.yml`. Writes return events as the `/run` response body; customer's CI commits. Private frames need a user-supplied GitHub token (post-alpha). Non-GitHub storage (GitLab / self-host) is out of scope for v1.

5. ~~**Receipt UX detail level.**~~ ✅ Decided 2026-05-11: **events.ndjson-shape from day one**. Per-tool line items, source URLs on every event, joinable to frame events by `run_id`.

6. ~~**Catalog spam filtering.**~~ ✅ Decided 2026-05-11: **server-side at runtime**. tick filters catalog.frames.ag results by `quality.l30DaysTotalCalls > 0` before exposing tools to agents. Never shows zero-traffic descriptors.

7. ~~**Distribution model.**~~ ✅ Decided 2026-05-11: **dual (hosted + local CLI)**. Same code as `@frames-ag/tick` CLI (local stdio against `frame serve`) and POST `/run` (HTTP against `tick.frames.ag`). Customers pick.

8. ~~**Frames-product relationship.**~~ ✅ Decided 2026-05-11: **sibling app + shared types package**. `apps/tick/` stays its own app (different runtime model, different cron, different DO lifecycle). `packages/tick-types/` shares types across `apps/tick` + `apps/frames-cloud`. No merge.

9. ~~**Upstream contribution policy.**~~ ✅ Decided 2026-05-11: **contribute immediately**. EVM MPP for Faremeter, frame v0.0.2, Workers-native Faremeter adapter — all open-source the day they ship. Moat is product packaging + curation, not protocol code.

10. ~~**GitHub App scopes for Mode 2.**~~ ✅ Decided 2026-05-11: **minimal scopes** — `contents:write` on selected repos only. No org-level access, no metadata read beyond what's required to commit. Broader scopes (if ever needed) ship as a separate opt-in.

11. ~~**SKILL package location.**~~ ✅ Decided 2026-05-11: **inside `apps/tick/` itself**, at `apps/tick/skill/SKILL.md`. Skill ships with the runtime release; tight coupling so prompt docs stay in sync with the actual op semantics. Install via `npx skills add https://github.com/frames-engineering/frames-monorepo --skill tick` (subdir resolution).

---

## Source reports

Full source research lives in agent transcripts (May 11 2026). Key references:

- **Frame protocol:** [`packages/frame/PROTOCOL.md`](../../packages/frame/PROTOCOL.md) — events.ndjson schema, projection semantics, source schema
- **Frame MCP:** [`packages/frame/MCP.md`](../../packages/frame/MCP.md) — 9 curation tools, write lock semantics
- **Frame skateboard plan:** [`packages/frame/PLAN.md`](../../packages/frame/PLAN.md) — staged build, anti-revisit decisions
- **Pay spec:** [`packages/pay/SPEC.md`](../../packages/pay/SPEC.md) — ToolDescriptor, Wallet, CatalogSource, manifests
- **Catalog:** [`apps/catalog/README.md`](../catalog/README.md) — 5,797 descriptors federated from x402 Bazaar + MPP + Frames Registry
- **Frames Cloud plan:** [`apps/frames-cloud/PLAN.md`](../frames-cloud/PLAN.md) — Tier 3 item 15 is this product
- **Real-workload evidence:** GitHub Actions logs from `microchipgnu/frames-examples` (May 5 tick) and `microchipgnu/blindspot.news` (May 11 cycle) — 5× LLM call variance, 130× tool call variance; ~$0.50/cycle blindspot, $0.10–$2.00/tick frames-examples
- **Pre-mortem:** [`PreMortem-tiered-inference-2026-05-11.md`](./PreMortem-tiered-inference-2026-05-11.md) — pre-reframe risk analysis (most launch-blocking Tigers neutralize once we're the frame-cloud runtime, not generic inference)
