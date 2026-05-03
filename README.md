# pay

The buyer-side runtime for paid agent tool calls. Discover a tool, pay for it, get the result.

A library, a CLI, and (later) an MCP server. Local-first. Built on **[faremeter](https://docs.faremeter.xyz)** for the wire layer (x402, MPP, multi-chain wallets). Pay owns the catalog, manifest, budget, and audit layers on top.

## Documents

- **[SPEC.md](./SPEC.md)** — wire formats and interfaces. The contract.
- **[PLAN.md](./PLAN.md)** — staged implementation, with progress.

These are versioned semver and are the contract another implementer would honor. Everything else in this repo is one valid implementation, not the protocol.

## Two halves

| Half | What it does | Implementation |
|---|---|---|
| **Catalog** | discovers what tools exist and how to invoke them | descriptor JSON + manifest (`tools.yml`) + lockfile (`tools.lock`), npm-shaped |
| **Wallet** | pays for a tool call and returns the result | thin bridge over faremeter — any `@faremeter/wallet-*` works (OWS, EVM, Solana, Squads, Ledger, Crossmint) |

Same architectural shape on both sides: descriptors are content-addressed, locked on first install, replayable from disk. Wallet types come from faremeter; protocols (x402, x402v2, MPP) come from faremeter.

## Status

Pre-v0. See [PLAN.md](./PLAN.md) for what ships when.
