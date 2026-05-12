# frames-monorepo — value-capture strategy notes

> Working notes from a 2026-05-12 strategy conversation. Not a decided plan —
> a snapshot of the options on the table and the framing that produced them.

---

## What's actually in the stack today

| Component | What it is today | What it does NOT do |
| --------- | ---------------- | ------------------- |
| `apps/tick/` | Open-source runtime for frame curation. Four ops, x402-native billing wired (no SaaS layer). | Doesn't host anything yet. Doesn't take a cut. |
| `apps/catalog/` | Read-only metadata registry. 5,797 ToolDescriptors, quality-scored by `l30DaysTotalCalls`, federated, searchable. | Doesn't hold funds. Doesn't verify signatures. Doesn't sit in the money path. Doesn't take a cut. **It's a phone book, not Visa.** |
| `apps/frames-cloud/` | REST resolver for frame datasets (GitHub-backed projection). | Doesn't host writes; customer's CI commits. |
| `apps/tick-facilitator/` | Self-hosted Faremeter for x402/MPP verify+settle. Built but not deployed; CDP can substitute on Base-only for v1. | — |
| `packages/{frame,pay,payment-tempo,tick-types}/` | Open protocol + types + integrations. | Protocols rarely capture value directly. |
| Datasets (`microchipgnu/ai-agent-wallets-eu`, `blindspot.news`) | Two real curated datasets, produced by tick. | — |

The actual money path today: **buyer wallet → seller's facilitator → seller**. None of our infra is in that path. We publish URLs (catalog) and run the agent that decides which URL to fetch (tick).

---

## Four plausible value-capture paths

| # | Path | What it captures | Distance from today | Honest read |
| - | ---- | ---------------- | ------------------- | ----------- |
| 1 | **Hosted tick** (`tick.frames.ag`) | Margin per `/run` — LLM token markup via AI Gateway, convenience, audit trail, managed wallets | 0 — code is ready, needs deploy | Fastest path to revenue. Natural OpenRouter-shaped product with stronger pricing semantics (outcome-priced, not token-priced). Commoditizes if customers self-host the open-source CLI. |
| 2 | **Catalog routing API** | Per-decision fee on a smart-router endpoint (`/route?capability=…&budget=…`) | Medium — need routing logic + paywall | You have the traffic data (`l30DaysTotalCalls`), sellers don't. Asymmetric and defensible. Needs hosted-tick volume first to make the data useful. |
| 3 | **Catalog-as-facilitator** | Per-tx fee on every paid call routed through it (0.5-2%) | Large — gas, custody, dispute handling, compliance | This is what "x402 Stripe" would actually look like. Real moat once it works, but a different business — custody-adjacent. |
| 4 | **Dataset publishing** | Per-subscription on premium curated datasets | Small — 2 datasets already exist | Bloomberg shape, not Stripe shape. Higher margin per customer, lower scale, you control distribution. Different muscle from infra. |

---

## Stated current bet

**Hosted tick = primary revenue thesis** (user, 2026-05-12).

Steelman:
- Outcome-priced (`$0.50 to verify a frame`) > token-priced (`$0.000003/token`)
- You control the agent loop — model selection, catalog routing, sub-agent spawning, sandbox extraction become operational levers self-hosters can't replicate
- AI Gateway BYOK margin is real and per-call
- Receipts + signed events + audit trail = compliance pitch (GDPR, AI Act, SOX)
- Wallet-is-identity only works hosted (local CLI customer brings their own wallet)
- Volume → tool-price negotiation; customers ride your floor

Things that could erode it:
- Open-source CLI means customers self-host the moment your pricing exceeds their CF bill (~$5/mo). Operational excellence has to compound faster than that arbitrage closes.
- LLM hosting is margin-compressed (OpenRouter, Anthropic direct, AI Gateway already exist)
- x402 native billing requires a wallet + USDC + per-request signing — that's friction most customers don't want vs. an API key

The hosted bet works if operational excellence (catalog routing intelligence, sub-agents, sandbox, latency, reliability) accrues faster than the self-host arbitrage closes. It doesn't work if hosted is "the same code, on our CF account."

---

## The catalog framing mistake (worth not repeating)

In an earlier conversation I framed the catalog as "x402 Stripe / the settlement layer for paid AI tools." That was wrong. The catalog as it exists today is a **read-only metadata registry**. To become a settlement layer it has to do one of paths #2 or #3 above — and those are real engineering + ops commitments, not framing tricks.

**Honest rule for future conversations:** don't call the catalog a "layer" until it's in the money path. Until then it's a directory.

---

## Phase B finding (2026-05-12) — CDP is now drop-in (rewrite shipped same day)

Initial investigation found our `verifyInboundX402` / `settleX402` used a custom shape that didn't match canonical x402 v2. **Same-day fix landed in v0.0.3**: rewrote the inbound client to be x402-v2 native (`apps/tick/src/payment/{types,payment-requirements,x402}.ts`), added 402 challenge emission on `/run`, plus `TICK_PAY_TO_ADDRESS` / `_NETWORK` / `_ASSET` env config.

CDP integration is now a few-secrets flip per `apps/tick/DEPLOY.md` Phase B section. Same code works against CDP and our own tick-facilitator (Faremeter v0.21.0+ also speaks v2). 27 new x402 wire-shape tests prevent regression.

**Single remaining CDP-specific question**: does CDP require an auth header (API key / project ID) on `/v2/x402/verify` and `/settle`? The client already supports it via the `facilitatorAuthHeader` param; app-level wiring is a one-line addition once we know the header name.

## What to revisit when

- **Before npm publish** — is the answer still "hosted is the bet"? If yes, what's the minimum hosted surface for v1 (one customer, one frame, one workflow)?
- **First paying hosted customer** — does the unit economics hold? LLM markup × volume - CF costs - support time = ?
- **Three months post-launch** — has anyone self-hosted? If yes, why? If no, why not?
- **First custom routing request** — does someone ask "which is the cheapest web-search tool?" That's the signal path #2 (routing API) is worth building.
- **First "I wish you handled the payment for me"** — that's path #3 (catalog-as-facilitator) demand.

If none of those signals fire in the first six months, the bet probably needs revisiting.
