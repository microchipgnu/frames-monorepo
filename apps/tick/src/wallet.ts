// Outbound payment wallets for tick.
//
// Self-custody, env-loaded. Two private keys serve four payment paths:
//
//   SOLANA_OUTBOUND_KEYPAIR_JSON → Solana x402 + Solana MPP charge
//   EVM_OUTBOUND_PRIVATE_KEY     → Base x402 + Tempo MPP charge (same key, two chains)
//
// **v0.4.0 — pay consolidation.** Tick used to wire faremeter handlers
// directly here (parallel to what `@frames-ag/pay`'s `wallet/` module
// already does). That was an architectural smell: 117 lines of tick code
// duplicated 1,565 lines of buyer-side payment infrastructure already
// shipped in pay. Now tick builds a `WalletRegistry` and hands it to
// pay's `createPaidFetch` — pay owns the faremeter integration.
//
// Practical benefits:
//   - One faremeter integration point in the monorepo (pay, not tick + pay)
//   - Future faremeter upgrades (e.g., adopting `@faremeter/rides`) happen
//     once in pay, not separately here
//   - Tempo MPP loads via pay's existing dynamic-import path
//   - Tick gets pay's wallet-registry diagnostics (label, source, address)
//     surfaced through receipts when we wire them later
//
// Per PLAN.md §6 — no agentwallet proxy, no Coinbase Agentic, no Stripe.

import { WalletRegistry, createPaidFetch, type WalletEntry } from "@frames-ag/pay/wallet";
import { createLocalWallet as createSolanaWallet } from "@faremeter/wallet-solana";
import { createLocalWallet as createEvmWallet } from "@faremeter/wallet-evm";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Bindings } from "./env";

export interface BootedWallets {
  /** Drop-in replacement for global fetch that auto-pays 402s. */
  paidFetch: typeof fetch;
  /** True if the booted wallets cover all four payment paths (x402 EVM+Solana, MPP Solana+Tempo). */
  fullyConfigured: boolean;
  /** Diagnostic info for /health / receipts. */
  config: {
    solanaConfigured: boolean;
    evmConfigured: boolean;
    tempoConfigured: boolean;
  };
}

/**
 * Boot the outbound wallet stack from Worker env. Missing secrets degrade
 * gracefully: each chain is independent. Returns paidFetch even when no
 * wallets are configured (it's a thin pass-through to global fetch in
 * that case — paid 402 calls just fail loudly).
 */
export async function bootWallets(env: Bindings): Promise<BootedWallets> {
  const byNetwork: Record<string, WalletEntry[]> = {};
  let solanaConfigured = false;
  let evmConfigured = false;
  let tempoConfigured = false;

  // ----- Solana x402 + Solana MPP charge ---------------------------------
  if (env.SOLANA_OUTBOUND_KEYPAIR_JSON && env.SOLANA_RPC_URL) {
    let secretKey: Uint8Array;
    try {
      secretKey = Uint8Array.from(JSON.parse(env.SOLANA_OUTBOUND_KEYPAIR_JSON));
    } catch (e) {
      throw new Error(
        `SOLANA_OUTBOUND_KEYPAIR_JSON is not a valid 64-byte JSON array: ${(e as Error).message}`,
      );
    }
    const solanaWallet = await createSolanaWallet("solana:mainnet", secretKey);
    byNetwork["solana-mainnet"] = [{
      kind: "solana",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: solanaWallet as any,
      label: "tick-outbound",
      source: "env",
    }];
    solanaConfigured = true;
  }

  // ----- Base x402 + Tempo MPP charge (same EVM key) ---------------------
  if (env.EVM_OUTBOUND_PRIVATE_KEY) {
    const evmKey = env.EVM_OUTBOUND_PRIVATE_KEY as `0x${string}`;
    const evmWallet = await createEvmWallet(base, evmKey);
    byNetwork["base-mainnet"] = [{
      kind: "evm",
      wallet: evmWallet,
      label: "tick-outbound",
      source: "env",
    }];
    evmConfigured = true;

    // Tempo MPP uses the same private key, exposed as a viem Account.
    // pay's createPaidFetch lazy-imports `@frames-ag/payment-tempo` for us.
    //
    // The `as any` on `account` is a workaround for bun's monorepo
    // resolution producing two viem instances when pay and tick have
    // independent dep trees. Runtime shape is identical; TS sees two
    // distinct Account types. Resolves cleanly once we dedupe viem at
    // the root workspace level.
    const tempoAccount = privateKeyToAccount(evmKey);
    byNetwork["tempo"] = [{
      kind: "tempo",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      account: tempoAccount as any,
      label: "tick-outbound",
      address: tempoAccount.address,
      source: "env",
    }];
    tempoConfigured = true;
  }

  const registry = new WalletRegistry({
    byNetwork,
    agent: "tick",
  });

  const { paidFetch } = await createPaidFetch({
    registry,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    retryCount: 2,
    initialRetryDelay: 100,
  });

  return {
    paidFetch,
    fullyConfigured: solanaConfigured && evmConfigured && tempoConfigured,
    config: { solanaConfigured, evmConfigured, tempoConfigured },
  };
}
