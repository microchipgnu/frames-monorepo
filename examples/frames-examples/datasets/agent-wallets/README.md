# agent-wallets

A live catalog of **agent wallets, payment registries, and payment
protocols** — and the tool/service endpoints each one exposes for
agents to call. One entity per product.

The point is to be able to ask: "What wallets exist? What services does
each one expose to agents? On which chains? Authed how? Priced how?" —
and get a current answer without bouncing across ten landing pages.

## In scope

- **Wallets** designed for agents (programmatic signing, policy
  controls, multi-chain support, etc.).
- **Registries** that catalog services / APIs that agents can call,
  with payment built in (x402, native stables, card, etc.).
- **Payment protocols** that compose with the above (x402, Lightning,
  HTTP-Pay, etc.) — even when they're not a wallet themselves.
- For each, the **services** it exposes: name, endpoint, brief. Top 10
  most-recently-confirmed live in the row; full history lives in
  `events.ndjson` via attached evidence.

## Out of scope

- Generic crypto wallets (MetaMask, Phantom) without explicit
  agent-targeted features.
- Stablecoin issuers (Circle, Tether) unless they ship an agent
  payment surface directly.
- Defunct projects with no working API and no announcements in 12+
  months — those move to `status: dead`, not deleted.

## Refresh policy

Daily cron, but each tick budgets only ≤ 2 new admissions and ≤ 3
existing refreshes — so each entity gets touched roughly weekly. New
admissions require a vendor blog post, GitHub release, or material
announcement as the primary source. `api_base_url` is verified live on
every refresh; if it 404s and no replacement is found, status → `dead`.
