#!/usr/bin/env bun
//
// Provisions a Coinbase Agentic Wallet (CDP MPC + TEE wallet) for tick's
// outbound x402 payments. Custodial: Coinbase holds the keys; we hold an
// API key that authorizes per-session signing under policy.
//
// Required env vars (export before running, or pass via a .env file):
//
//   CDP_API_KEY_NAME   — Coinbase CDP API key name (from coinbase.com/cloud)
//   CDP_API_KEY_SECRET — the corresponding secret
//
// Optional:
//
//   CDP_WALLET_NAME    — display name for the wallet (default "tick-prod")
//   CDP_NETWORK        — initial network to provision against (default "base-mainnet")
//
// Output:
//   stdout — JSON object { wallet_id, address, network }
//   stderr — human-readable summary + next steps
//
// Usage:
//   export CDP_API_KEY_NAME=...
//   export CDP_API_KEY_SECRET=...
//   bun run scripts/provision-cdp-wallet.ts > cdp-wallet.json
//
// Then in production:
//   wrangler secret put CDP_API_KEY_NAME    --config apps/tick/wrangler.toml
//   wrangler secret put CDP_API_KEY_SECRET  --config apps/tick/wrangler.toml
//   wrangler secret put CDP_WALLET_ID       --config apps/tick/wrangler.toml
//
// IMPORTANT: this is a stub. The CDP API surface for Agentic Wallets is
// still in preview as of 2026-05-11. Validate against the live docs:
//   https://docs.cdp.coinbase.com/agentic-wallets
//
// Once the API stabilises, fill in the TODO sections below and remove this
// notice. The wallet shape we want for tick is:
//   - MPC + TEE-isolated signer
//   - Per-session sub-allocation (master key idle, ephemeral session keys sign)
//   - Policy ceiling per session (e.g., $5 max per outbound batch)

import { env } from "node:process";

interface ProvisionedWallet {
  wallet_id: string;
  address: string;
  network: string;
}

async function main(): Promise<void> {
  const apiKeyName = env.CDP_API_KEY_NAME;
  const apiKeySecret = env.CDP_API_KEY_SECRET;
  if (!apiKeyName || !apiKeySecret) {
    console.error("Error: CDP_API_KEY_NAME and CDP_API_KEY_SECRET must be set.");
    console.error("");
    console.error("Get credentials at: https://portal.cdp.coinbase.com/");
    console.error("Then:");
    console.error("  export CDP_API_KEY_NAME='...'");
    console.error("  export CDP_API_KEY_SECRET='...'");
    console.error("  bun run scripts/provision-cdp-wallet.ts");
    process.exit(1);
  }

  const walletName = env.CDP_WALLET_NAME ?? "tick-prod";
  const network = env.CDP_NETWORK ?? "base-mainnet";

  console.error("--- Coinbase Agentic Wallet provisioning (PREVIEW) ---");
  console.error(`name:    ${walletName}`);
  console.error(`network: ${network}`);
  console.error("");

  // ----------------------------------------------------------------------
  // TODO: replace this stub with real CDP API calls.
  // The CDP SDK (`@coinbase/coinbase-sdk`) hits:
  //   POST /platform/v1/wallets
  // with a JWT-signed body. The response contains:
  //   { id, default_address: { address_id, network_id } }
  //
  // Sketch (NOT TESTED — verify against current API):
  //
  //   import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
  //   Coinbase.configure({ apiKeyName, privateKey: apiKeySecret });
  //   const wallet = await Wallet.create({ networkId: network });
  //   const address = await wallet.getDefaultAddress();
  //   return {
  //     wallet_id: wallet.getId(),
  //     address: address.getId(),
  //     network: address.getNetworkId(),
  //   };
  //
  // For now we emit a placeholder that fails loudly when used.
  // ----------------------------------------------------------------------

  const result: ProvisionedWallet = {
    wallet_id: "TODO-not-yet-provisioned",
    address: "TODO-not-yet-provisioned",
    network,
  };

  console.error("⚠ STUB IMPLEMENTATION — this does not actually call CDP.");
  console.error("  Wire up `@coinbase/coinbase-sdk` (or fetch their REST API) here.");
  console.error("  See TODO block in the source for the sketch.");
  console.error("");
  console.error("When real:");
  console.error(`  wrangler secret put CDP_API_KEY_NAME    --config apps/tick/wrangler.toml`);
  console.error(`  wrangler secret put CDP_API_KEY_SECRET  --config apps/tick/wrangler.toml`);
  console.error(`  wrangler secret put CDP_WALLET_ID       --config apps/tick/wrangler.toml`);
  console.error("");

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // Don't exit 0 while it's still a stub — that masks the "you haven't actually
  // provisioned anything" reality. Exit 2 to signal "incomplete".
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
