# Pre-Mortem: Tiered Agent Inference Service

**Date:** 2026-05-11
**Working name:** TBD (later named **`tick`**)
**Plan reference:** `apps/inference/PLAN.md` → now `apps/tick/PLAN.md`
**Imagined launch:** ~2026-06-22 (end of 6-week build plan)

> **Status (as of 2026-05-11, marked historical): HISTORICAL.** This document captures the
> 2026-05-11 pre-mortem against an early version of the plan. Several risks
> referenced here have shipped mitigations or been resolved by scope changes:
>
> - **OpenRouter overlap (T1)** — addressed by repositioning as a frame-runtime
>   (curate / verify / refresh / discover), not a generic inference router.
> - **Faremeter facilitator drift (T2)** — pinned to v0.21.0 in
>   `apps/tick-facilitator/Dockerfile`; env-config patch verified against fresh clone.
> - **Sandbox cold-start (T3)** — sandbox usage deferred past v1; the v1 ops
>   don't require code-exec.
> - **Billing surprise (T4)** — `descriptor.payment.price_hint` is pre-checked
>   against remaining budget in `catalog-dispatch.ts` before any signed call.
> - **Stripe MPP dependency (T5)** — eliminated by `@frames-ag/payment-tempo`
>   (no Stripe in critical path).
>
> The product name, scope, and protocol stack have all moved on. Read this as a
> 2026-05-11 snapshot, not a current risk register. The current source of
> truth is `apps/tick/PLAN.md` §9 (sprint plan with ✅/⏳ markers).

---

## Failure scenario

It's August 2026. The service launched in late June. Wallet sign-ups stalled around the launch cohort. OpenRouter shipped x402 ingress + a tools marketplace 11 days after our alpha. The handful of early adopters churned within two weeks citing "weird billing," a sandbox boot-time issue on Deep tier, and a partial outage where Faremeter v0.22 broke our facilitator config patch. We never crossed $5K MRR. We're now debating whether to mothball the service and fold tier-routing logic into Frames itself.

What did we miss?

---

## Tigers (real risks)

### T1. OpenRouter ships the same surface during our build window — **Launch-Blocking**

The competitive research already flagged ~60% likelihood within 12 months. OpenRouter has Presets, an Agent SDK, server-side Server Tools (web search, datetime, TTS as of May 4 2026), and the largest model catalog. They are one product decision away from adding x402 ingress + a curated tool palette. If they ship inside our 6-week build window, we launch into a market with the dominant aggregator already covering 80% of our value prop with 100× our distribution.

### T2. Dellbot adds a tool layer to its existing tiered x402 endpoint — **Launch-Blocking**

Dellbot already ships 3 inference tiers on x402 with USDC settlement on Base. Adding paid-tool integration (Exa, Firecrawl) is a few weeks of engineering. They're indexed on agentic.market. Our differentiation collapses if they ship first.

### T3. Coinbase Agentic Wallet operational risk — **Launch-Blocking**

V1 plan: single Wallet DO holding funds for all outbound x402 calls. A bug in budget-decrement logic, a compromised CDP API key, or a malformed signer interaction could drain the operator wallet. "Migrate to per-session sub-wallets later" is the right architectural answer but exposes real money in the interim.

### T4. AI Gateway BYOK rate-limit collision — **Launch-Blocking**

Single Anthropic / OpenAI / Google API key per provider, shared across all tiers. One spammy Quick session burns the quota; concurrent Deep session hits 429. Plan §8 flags this but the mitigation ("AI Gateway rate limits keyed on `cf-aig-metadata.tier`") needs day-one config or Deep customers see failures.

### T5. No observability or on-call by launch — **Launch-Blocking**

The 6-week build plan does not include logging, metrics, alerting, dashboards, or on-call rotation. Public alpha without observability means silent failures, no MTTR, no signal on which tier breaks first. This is the classic "we'll add monitoring after launch" mistake that turns "launched a thing" into "launched a thing that quietly fails."

### T6. Sandbox attack surface from model-generated code — **Launch-Blocking**

Deep tier executes model-written shell commands and Python in a sandbox with an egress proxy. Adversarial users can craft prompts that produce: crypto miners on our vCPU, attempts to bypass the egress proxy by directly resolving DNS / making raw socket calls, attempts to exfiltrate the sandbox's filesystem to attacker-controlled R2 paths, attempts to escalate within the container. Plan does not mention sandbox hardening (network policy, CPU caps, suspicious-syscall detection).

### T7. `upto` scheme client compatibility — **Launch-Blocking**

The plan defaults to x402 v2 `upto` scheme. Many x402 clients in the wild still only speak `exact` (v1). Faremeter does auto-negotiate, but the auto-negotiation behavior under `upto`-only servers is something we need to verify works for the major client SDKs (Coinbase x402-fetch, Faremeter fetch, third-party MCP clients). If our endpoint refuses `exact`-only clients, we just made our launch addressable market 30–50% smaller.

### T8. Variable-price UX kills broader market — **Fast-Follow**

"$0.25 max, you'll be charged what we used" is honest but hard to communicate. Power users on x402 understand `upto`. Newcomers see variable charges and bounce. The receipt UX is supposed to fix this; the plan flags receipts as a "brand surface" but does not fully spec it.

### T9. Budget reconciliation drift across three systems — **Fast-Follow**

DO local decrement + AI Gateway Custom Costs + Faremeter settled amount are three independent ledgers. Under normal conditions they agree. Under network blips, mid-call crashes, or retry storms they will diverge. The plan says "trust Custom Costs on divergence" but doesn't specify reconciliation cadence, alert thresholds, or refund automation.

### T10. Faremeter version pinning and config-patch drift — **Track**

Faremeter is v0.21 (pre-1.0) with active development. We're patching the config loader for env-based keypair loading. A v0.22 release that changes the config-loader internals breaks our patch. Plan should pin a version and gate upgrades.

### T11. Sandbox cold start on first Deep-tier call — **Fast-Follow**

Pre-warm-on-settle helps but is only useful if the agent actually uses the sandbox. If the agent's first turn doesn't need code-exec, the pre-warm is wasted spend. If it does, the user waits ~30s on top of the model's first token latency. Snapshots help second+ session but not first. Latency = "this is slow" perception in early reviews.

### T12. Solo-founder bandwidth across the 6-week build — **Track**

Owner = Luís. Six weeks spans: facilitator container deploy, Worker scaffolding, DO + agent loop, AI Gateway BYOK config, Sandbox integration, x402 tools, MPP integration, SIWX read endpoints, receipts UX, landing page, docs, and ops. Realistic for one person while also running Frames? Risk of week-N slip.

---

## Paper Tigers (overblown concerns)

### PT1. "We need MPP on every chain at launch"

Solana dominates agent payment tx count (~50–80%); Base covers EVM with x402. The launch matrix in PLAN.md §5 honestly admits MPP is Solana-only at launch. This is fine — customers who *need* Base MPP go to Stripe directly; the rest are well served by Solana MPP + x402-everywhere. EVM MPP is a planned upstream contribution, not a launch gate.

### PT2. "DIY-via-MCP eats our market"

The competitive research called this out. In reality, the "I'll script it myself with agentcash + pay" buyer is not our customer — they want primitives, not a tiered product. We're selling opinionated curation to developers who explicitly want to *not* assemble five tools.

### PT3. "What if x402 loses to MPP entirely?"

Both are now standards-track (Linux Foundation x402, Stripe-led MPP) and explicitly positioned as complementary by both parties. Our dual-protocol bet hedges this naturally.

### PT4. "Cloudflare deprecates Sandboxes / Containers / AI Gateway"

CF just GA'd Sandboxes April 2026 and is investing heavily in the agent stack (AI Gateway BYOK, Dynamic Workflows, Agentic Payments docs). No deprecation risk on launch-relevant timescales. Lock-in concern is real long-term but not a launch risk.

### PT5. "We need our own MPC wallet stack"

Coinbase Agentic Wallets cover MPC + TEE + per-session policy primitives. Rolling our own is years of work for marginal differentiation. The hot-wallet risk (T3) is about *operations*, not about whether to use CDP's wallets.

### PT6. "Faremeter is open-source — competitors will copy"

Faremeter is GPL-3.0; the protocol code isn't the moat anyway. The moat is curated tier-mesh + receipt UX + opinionated product packaging. Contributing EVM MPP upstream after launch is correct strategy, not a leak.

---

## Elephants (unspoken worries)

### E1. We have zero validation that anyone wants this

The plan was synthesized from competitive analysis and protocol research. No customer interviews. No "$10 deposit if you'd use this." The closest validation is "Dellbot and Otto AI are building adjacent products, so the surface is real" — but that's *competitive* signal, not *demand* signal. We should talk to 10 prospective users before week 6.

### E2. No free-tier / first-call experience

Every successful API service has a free tier or first-N-calls-free hook. Wallet+x402 friction for the very first call may be high enough to lose 80% of trial intent. The plan does not address this. A "10 free Quick calls signed by wallet, no payment required" hook is probably essential and absent.

### E3. No distribution plan beyond "announce"

Week 6 ends at "public alpha announcement." How do customers actually find us? No mention of agentic.market listing, x402 directory submission, Twitter strategy, Hacker News post, integration with MCP catalogs, partner outreach. Build-it-and-they-will-come never works.

### E4. Pricing benchmark vs. Perplexity Sonar Pro

Perplexity Sonar Pro is $3/$15 per 1M tokens + $14–22 per 1K requests. Our Deep at $0.75/call needs to be obviously better or cheaper for the same task — and we haven't benchmarked head-to-head. If a typical Deep query is comparable to a Sonar Pro deep-research query at a similar price, our wedge is purely "we accept USDC" which is narrow.

### E5. Cache-hit economics

Opus cache hit at $0.50/MTok (90% off) is in the plan as a footnote. If we aggressively cache the system prompt + tool manifest across calls, Deep tier margin improves substantially. No caching strategy specified; we may launch with worse-than-necessary economics.

### E6. Model-binding refresh cadence

Tier names are evergreen ("Quick/Smart/Deep"); model selections (Haiku 4.5, Sonnet 4.6, Opus 4.7) will be superseded in 6 months. Process for swapping models, communicating to customers, and not breaking existing integrations is not specified.

### E7. Frames cannibalization or synergy

PLAN.md §10 flags as an open decision but no analysis exists. If Frames internally calls upstream LLMs, this service could lower Frames' costs *and* prove the product. If we run separate billing for separate brands, we duplicate work. Worth a one-page decision doc before launch.

### E8. Regulatory exposure timing

Operator wallet receiving USDC and paying out is *probably* not money transmission below ~$1M/yr, but the threshold and state-by-state interpretation are unclear. Plan says "get counsel above $1M/yr" — but the *first* year is exactly when you're most vulnerable to a regulator looking at a new service with strange flows.

---

## Action plans for Launch-Blocking Tigers

### T1 — OpenRouter ships first

- **Risk:** OpenRouter adds x402 + tools marketplace before our launch, collapsing our wedge.
- **Mitigation:** (a) Compress build plan — move MPP-on-Solana to week 4 and skip Stripe-MPP opt-in until post-launch (week 5 becomes hardening). (b) Pre-announce on Twitter / agentic.market in week 4 with a waitlist to lock interest. (c) Differentiate on "tool-mesh curation + wallet-native receipts" — both things OpenRouter won't ship in a v1.
- **Owner:** Luís (compression decision) + community/marketing (pre-announce).
- **Due:** Week 4 of build plan (~2026-06-08).

### T2 — Dellbot adds tools

- **Risk:** Dellbot ships tool support before us.
- **Mitigation:** Monitor `x402.dellbot.win` weekly. If they ship, refocus our positioning on the agent-with-sandbox + receipts UX angle, which is harder to replicate quickly. Don't pivot — execute faster.
- **Owner:** Luís.
- **Due:** Weekly monitoring throughout build. Decision point if Dellbot ships: 48-hour positioning revision.

### T3 — Hot wallet operational risk

- **Risk:** Coinbase Agentic Wallet drained via budget-decrement bug, key compromise, or signer misuse.
- **Mitigation:** (a) Hard daily-spend cap on the Wallet DO (e.g., $200/day for alpha). (b) Alerting on any single outbound transaction > $5. (c) CDP wallet policy ceiling matching daily cap. (d) Move to per-session sub-wallets earlier than originally planned — promote from "later" to week 5.
- **Owner:** Luís.
- **Due:** Daily cap + alerts before any external traffic (week 2). Per-session sub-wallets by week 5.

### T4 — AI Gateway rate-limit collision

- **Risk:** Shared provider keys hit 429 under tier mixing.
- **Mitigation:** Configure per-tier rate-limit rules in AI Gateway from day one (week 1). Use separate gateways per provider if AI Gateway rate-limit granularity is insufficient. Add automatic fallback to alternate provider via Dynamic Routing.
- **Owner:** Luís.
- **Due:** Week 1, before stub agent goes live.

### T5 — Observability / on-call

- **Risk:** Silent failures in public alpha.
- **Mitigation:** Add to build plan as week 2 work (parallel with Quick tier going live): (a) Structured logging from Worker + DO + facilitator container to a single sink (Workers Logs, BetterStack, or Datadog). (b) Dashboards for: settle success rate, tier-specific p50/p95 latency, budget-overrun events, AI Gateway 429s, facilitator health. (c) PagerDuty / SMS alert on settle failure rate > 5% or facilitator 5xx > 1%.
- **Owner:** Luís.
- **Due:** Week 2 end, before Quick tier opens to friends.

### T6 — Sandbox attack surface

- **Risk:** Adversarial prompts exploit code-exec in Deep tier.
- **Mitigation:** (a) CF Containers network policy: only allow outbound DNS + HTTPS to the egress proxy domain. (b) Hard vCPU cap per sandbox instance (1 vCPU); hard wall-time cap per code-exec invocation (30s). (c) Reject sandbox spawn if budget < $0.05 (prevents zero-cost mining). (d) Log all `exec` calls to D1 for post-hoc review. (e) Manual review of every Deep tier prompt for first two weeks of alpha.
- **Owner:** Luís.
- **Due:** Before week 4 (Smart + Deep tier capability work).

### T7 — `upto` client compatibility

- **Risk:** v2 `upto`-only ingress refuses common `exact`-only clients.
- **Mitigation:** Test ingress against: Coinbase x402-fetch, Faremeter fetch, x402.org reference client, and at least 2 third-party MCP/x402 clients. If any only speaks `exact`, accept `exact` on `/agent/run` with a fixed price = the ceiling (we eat the P95 tail for legacy clients; charge premium to compensate).
- **Owner:** Luís.
- **Due:** Week 1.

---

## Fast-Follow Tigers (track within 30 days post-launch)

- **T8** Variable-price UX — iterate on receipt design + price-preview UX based on alpha feedback
- **T9** Budget reconciliation drift — instrument divergence between three ledgers; tune
- **T11** Sandbox cold start — measure actual hit rate; consider always-warm template per tier if economics justify
- **T12** Solo-founder bandwidth — bring in a contractor or AI-assisted dev if week-N slips by more than 2 days

## Track Tigers (monitor; act only if signal emerges)

- **T10** Faremeter version pinning — pin to v0.21.x via git submodule; gate upgrades through testing

---

## Elephant investigation plan

Before week 6 launch, do these:

1. **E1 + E2 + E3 — Validation, free tier, distribution:** 10 prospective customer conversations (1 hour total, async via DM). Use signal to decide: (a) free-tier shape, (b) which agentic.market / x402-directory listings to submit, (c) launch-day distribution targets.
2. **E4 — Perplexity benchmark:** run 10 representative Deep-tier queries through Perplexity Sonar Pro and our Deep tier. Compare answer quality and total cost. Adjust pricing if we're 2× more expensive without 2× value.
3. **E5 — Caching strategy:** spec a system-prompt cache for AI Gateway. Estimate margin lift; decide if launch-blocking.
4. **E7 — Frames relationship:** one-page decision doc — "Frames as internal customer: yes/no, billed how?" Resolve before alpha.
5. **E8 — Regulatory:** consult counsel for a 30-min review before going over $50K total volume.

---

## Pre-launch checklist (T-7 to T-0)

- [ ] All Launch-Blocking Tiger mitigations verified in production
- [ ] Observability dashboards live for 7+ days with no false alarms
- [ ] Wallet daily cap + alerts tested with simulated breach
- [ ] Free-tier mechanic (if any) tested with 5 wallets not previously seen
- [ ] At least 3 third-party x402 clients verified compatible
- [ ] Listed on agentic.market
- [ ] Receipt UX reviewed by 2 outside readers for clarity
- [ ] Frames-relationship decision documented
- [ ] Pre-mortem revisited and stale items updated
