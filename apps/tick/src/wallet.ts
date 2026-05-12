// Outbound payment wallets for tick.
//
// Self-custody, env-loaded. Two private keys serve four payment paths:
//
//   SOLANA_OUTBOUND_KEYPAIR_JSON → Solana x402 + Solana MPP charge
//   EVM_OUTBOUND_PRIVATE_KEY     → Base x402 + Tempo MPP charge (same key, two chains)
//
// `wrap()` from @faremeter/fetch auto-negotiates v1/v2 x402 and MPP based on
// the seller's 402 response. The agent loop just calls paidFetch(url); the
// protocol math is invisible above this module.
//
// Per PLAN.md §6 — no agentwallet proxy, no Coinbase Agentic, no Stripe.

import { wrap } from "@faremeter/fetch";
import type { PaymentHandler } from "@faremeter/types/client";
import type { MPPPaymentHandler } from "@faremeter/types/mpp";
import { createPaymentHandler as createEvmPaymentHandler } from "@faremeter/payment-evm/exact";
import { createPaymentHandler as createSolanaPaymentHandler } from "@faremeter/payment-solana/exact";
import { createMPPSolanaChargeClient } from "@faremeter/payment-solana/charge";
import { createLocalWallet as createSolanaWallet } from "@faremeter/wallet-solana";
import { createLocalWallet as createEvmWallet } from "@faremeter/wallet-evm";
import { createMPPTempoChargeClient } from "@frames-ag/payment-tempo";
import { address } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Bindings } from "./env";

/**
 * USDC mint address on Solana mainnet. The canonical token tick pays with on
 * the Solana side. (Tempo / Base use USDC too, configured per-chain inside
 * the payment handlers themselves.)
 */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
 * gracefully: each chain is independent, and tick falls back to the free
 * httpRefetcher for refetches that don't match any registered chain.
 *
 * Returns paidFetch even when no wallets are configured (it's a thin pass-
 * through to global fetch in that case — paid 402 calls just fail loudly).
 */
export async function bootWallets(env: Bindings): Promise<BootedWallets> {
  const handlers: PaymentHandler[] = [];
  const mppHandlers: MPPPaymentHandler[] = [];

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
    const usdcMint = address(SOLANA_USDC_MINT);

    handlers.push(
      createSolanaPaymentHandler(solanaWallet, usdcMint, env.SOLANA_RPC_URL),
    );
    mppHandlers.push(
      createMPPSolanaChargeClient({
        wallet: solanaWallet,
        mint: usdcMint,
        rpc: env.SOLANA_RPC_URL,
        broadcast: true,
      }),
    );
    solanaConfigured = true;
  }

  // ----- Base x402 + Tempo MPP charge (same EVM key) ---------------------
  if (env.EVM_OUTBOUND_PRIVATE_KEY) {
    const evmKey = env.EVM_OUTBOUND_PRIVATE_KEY as `0x${string}`;

    const evmWallet = await createEvmWallet(base, evmKey);
    handlers.push(createEvmPaymentHandler(evmWallet, { asset: "USDC" }));
    evmConfigured = true;

    // Tempo MPP uses the same private key, exposed as a viem Account.
    const tempoAccount = privateKeyToAccount(evmKey);
    mppHandlers.push(createMPPTempoChargeClient({ account: tempoAccount }));
    tempoConfigured = true;
  }

  const paidFetch = wrap(fetch as typeof fetch, {
    handlers,
    mppHandlers,
    retryCount: 2,
    initialRetryDelay: 100,
  }) as typeof fetch;

  return {
    paidFetch,
    fullyConfigured: solanaConfigured && evmConfigured && tempoConfigured,
    config: { solanaConfigured, evmConfigured, tempoConfigured },
  };
}
