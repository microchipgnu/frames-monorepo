---
"@frames-ag/tick": minor
---

add /addresses endpoint surfacing public outbound-wallet addresses

Lets operators fund the outbound wallets externally without booting the full paidFetch stack or holding the private keys. Returns the public Solana / EVM (Base) / Tempo addresses derived from the configured env secrets — null per chain when its secret isn't set.

Read-only, unauthenticated by design. Public addresses are not sensitive; private keys never appear in the response.

- New `deriveWalletAddresses(env)` helper in `src/wallet.ts`. EVM address comes from `viem`'s `privateKeyToAccount`. Solana address is the base58 of bytes [32..64] of the keypair JSON (standard Solana keypair layout: priv ‖ pub). Handles malformed inputs by returning null.
- New `GET /addresses` route in `src/app.ts` that calls the helper.
- 5 unit tests covering: no-config (all null), EVM derivation against a known viem test vector, Solana shape sanity, malformed JSON, wrong-length keypair.

Funding workflow:
```
curl https://tick.microchipgnu.workers.dev/addresses
# → { addresses: { solana: "...", evm: "0x...", tempo: "0x..." } }
# fund each address with USDC on its respective chain
```
