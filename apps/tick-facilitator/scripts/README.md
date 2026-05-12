# Wallet provisioning scripts

Three scripts. All print a human-readable summary to **stderr** and the secret value (key / JSON) to **stdout** — pipe stdout straight to `wrangler secret put` or redirect to a file.

| Script | Output | What it produces | Used by |
|---|---|---|---|
| `gen-solana-keypair.ts` | 64-byte JSON array | Solana ed25519 keypair (canonical `solana-keygen` format) | Facilitator admin (settles SOL/SPL x402 payments) |
| `gen-evm-keypair.ts` | `0x` + 64 hex chars | secp256k1 private key (works on Base, Ethereum, Polygon, Monad, Skale) | Facilitator gas-paying (EIP-3009 settlement) |
| `provision-cdp-wallet.ts` | JSON `{wallet_id, address, network}` | Coinbase Agentic Wallet (MPC + TEE) | Outbound x402 payments (paid catalog tools) — **STUB** until CDP wires up |

## Quickstart

```bash
cd apps/tick-facilitator

# 1. Solana admin keypair → wrangler secret
bun run gen:solana | bunx wrangler secret put SOLANA_ADMIN_KEYPAIR_JSON

# 2. Base EOA private key → wrangler secret
bun run gen:evm | bunx wrangler secret put EVM_FACILITATOR_PRIVATE_KEY

# 3. (Optional) Inspect first, then pipe:
bun run gen:solana > /tmp/solana-admin.json
cat /tmp/solana-admin.json | bunx wrangler secret put SOLANA_ADMIN_KEYPAIR_JSON
shred -u /tmp/solana-admin.json   # or just `rm` on macOS

# 4. RPC URLs (provider-issued, no generation needed)
echo 'https://api.mainnet-beta.solana.com' | bunx wrangler secret put SOLANA_RPC_URL
echo '{"base":"https://mainnet.base.org","polygon":"https://polygon-rpc.com"}' \
  | bunx wrangler secret put EVM_RPC_URLS
```

## Funding the wallets

After generating, fund both keys before deploying:

- **Solana admin** — needs SOL for transaction fees on settles. Fund the printed base58 address from your Solana wallet.
- **EVM facilitator** — needs ETH on Base (and any other EVM chain you enable) for EIP-3009 gas-paying transactions. Fund the printed `0x` address.

Typical funding: **0.1 SOL + 0.05 ETH on Base** carries the facilitator through ~100k tx of routine x402 settlement.

## CDP Agentic Wallet (preview)

`provision-cdp-wallet.ts` is a stub. The Coinbase Agentic Wallets API was in preview as of 2026-05-11; wire it up against the live docs at <https://docs.cdp.coinbase.com/agentic-wallets> when you're ready to provision production outbound. For dev/local, use Faremeter's wallet packages (`@faremeter/wallet-evm`, `@faremeter/wallet-solana`) with the keys from `gen-evm-keypair.ts` / `gen-solana-keypair.ts` instead — same signing surface, no custodial dependency.

## Security notes

- Both `gen:solana` and `gen:evm` use cryptographically secure random (Node's `crypto` module + viem's `generatePrivateKey`).
- Don't commit generated keys. The scripts print to **stdout** specifically so you can pipe without ever touching the filesystem.
- If you do redirect to a file, `chmod 600` it immediately and `shred`/`rm` once piped.
- Rotate keys before going to production at any volume. The dev keys generated here are fine for testing on Base Sepolia / Solana devnet but should be replaced for mainnet.
- The Coinbase Agentic Wallet is preferred over a self-custody EVM private key for outbound payments in production (MPC + TEE means a key compromise doesn't drain the wallet). The self-custody EVM key from `gen:evm` is for the facilitator's gas-payer role only — small balance, frequent rotation.
