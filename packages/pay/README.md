# pay

The buyer-side runtime for paid agent tool calls. Discover a tool, pay for it, get the result.

A library, a CLI, and an MCP server. Local-first. Built on **[faremeter](https://docs.faremeter.xyz)** for the wire layer (x402, MPP, multi-chain wallets). Pay owns the catalog, manifest, lock, audit, and frame integration on top.

## Install

```bash
# add pay-mcp to any harness's .mcp.json
{
  "mcpServers": {
    "pay": { "command": "bunx", "args": ["-y", "@frames-ag/pay-mcp"] }
  }
}
```

```bash
# or in a shell
bunx -y @frames-ag/pay wallet init        # provision a wallet
bunx -y @frames-ag/pay wallet status      # see what's configured
```

Requires **Bun 1.0+**.

## Quick start

```bash
bunx -y @frames-ag/pay wallet init --network base-sepolia
# → writes ~/.frames/pay/config.yaml
# → prints address + faucet links

# fund the address from base-sepolia faucets (free)

# add pay-mcp to your harness's .mcp.json (see above)
# restart the harness — agent now has 5 pay tools:
#   pay_tool, add_tool, list_tools, discover, wallet_status
```

## Documents

- **[SPEC.md](./SPEC.md)** — wire formats and interfaces. The contract.
- **[PLAN.md](./PLAN.md)** — staged implementation, with progress.

## Wallet kinds

Pay loads a faremeter-shaped wallet from `~/.frames/pay/config.yaml` keyed by network. Seven kinds today:

| `kind` | What it loads |
|---|---|
| `evm` | local EVM private key |
| `solana` | local Solana keypair |
| `crossmint` | Crossmint custodial Solana wallet |
| `ows` | Open Wallet Standard vault (EVM or Solana) |
| `agentcash` | reads `~/.agentcash/wallet.json` (sharing wallet with agentcash CLI) |
| `frames` | reads `~/.frames/secrets/<org>/x402.json` (sharing the OWS vault used by frames CLI / skill) |
| `agentwallet` | reads `~/.agentwallet/config.json` (delegated to hosted wallet at frames.ag) |

See `src/config.ts` for the full config-shape examples.

## What ships

- `pay` — CLI (`pay wallet init`, `pay wallet status`)
- `pay-mcp` — MCP server (stdio); exposes `pay_tool`, `add_tool`, `list_tools`, `discover`, `wallet_status`
- Library — TS imports from `@frames-ag/pay` for embedders

## Status

v0.0.1 — pre-release. Plug-and-play works for x402 EVM payments today. MPP-Tempo lands when [@frames-ag/payment-tempo](https://github.com/microchipgnu/payment-tempo) merges into faremeter or ships standalone.
