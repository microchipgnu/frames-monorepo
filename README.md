# pay

The buyer-side runtime for paid agent tool calls. Discover a tool, pay for it, get the result.

A library, a CLI, and (later) an MCP server. Local-first. OWS-signed by default. Catalogs are pluggable; a hosted canonical catalog ships separately.

## Documents

- **[SPEC.md](./SPEC.md)** — wire formats and interfaces. The contract.
- **[PLAN.md](./PLAN.md)** — staged implementation, with progress.

These are versioned semver and are the contract another implementer would honor. Everything else in this repo is one valid implementation, not the protocol.

## Two halves

| Half | What it does | Plugins |
|---|---|---|
| **Catalog** | discovers what tools exist and how to invoke them | static, HTTP (registry-shaped), MCP server |
| **Wallet** | pays for a tool call and returns the result | signers (OWS, future: KMS, Privy, Turnkey), protocols (x402, future: MPP) |

Same architectural shape on both sides: one facade, a registry of plugins keyed by string ID, pluggable storage interfaces.

## Status

Pre-v0. See [PLAN.md](./PLAN.md) for what ships when.
