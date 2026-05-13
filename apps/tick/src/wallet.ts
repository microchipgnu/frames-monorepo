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
// Static reference to @frames-ag/payment-tempo so wrangler's bundler ships
// the module into the deployed Worker. `@frames-ag/pay`'s createPaidFetch
// loads this package via `import(pkg)` with a runtime-variable specifier,
// which bundlers can't statically analyze — without this side-effect import,
// the module is missing from the bundle and the runtime dynamic import
// throws, which pay's catch translates as "not installed".
import "@frames-ag/payment-tempo";
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
  /** paidFetch handler counts — surfaced via /health so we can confirm at runtime which payment paths got registered with wrap(). */
  diagnostics: {
    /** x402 handlers registered with faremeter wrap(). */
    handlerCount: number;
    /** MPP handlers registered with faremeter wrap(). */
    mppHandlerCount: number;
    /** Which chain families produced at least one handler. */
    configured: {
      evm: boolean;
      solana: boolean;
      tempo: boolean;
    };
  };
}

/**
 * Public addresses for every configured outbound wallet. Used by `/addresses`
 * so operators can fund the wallets externally without booting the full
 * paidFetch stack. Returns `null` for any chain that isn't configured.
 *
 * Derived from env secrets — no wallet boot required. Safe to call from any
 * request handler.
 */
export interface WalletAddresses {
  solana: string | null;
  evm: string | null;
  tempo: string | null;
}

export function deriveWalletAddresses(env: Bindings): WalletAddresses {
  let solana: string | null = null;
  if (env.SOLANA_OUTBOUND_KEYPAIR_JSON) {
    try {
      const bytes = Uint8Array.from(JSON.parse(env.SOLANA_OUTBOUND_KEYPAIR_JSON));
      if (bytes.length === 64) {
        solana = base58Encode(bytes.slice(32));
      }
    } catch {
      // Malformed keypair JSON — surfaced as null; /balance will say configured=false.
    }
  }

  let evm: string | null = null;
  if (env.EVM_OUTBOUND_PRIVATE_KEY) {
    try {
      evm = privateKeyToAccount(env.EVM_OUTBOUND_PRIVATE_KEY as `0x${string}`).address;
    } catch {
      // Malformed hex; surface null.
    }
  }

  // Tempo MPP reuses the EVM key (see bootWallets for the rationale).
  const tempo = evm;

  return { solana, evm, tempo };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) * 256;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58_ALPHABET[digits[i] ?? 0];
  return result;
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

  const { paidFetch, diagnostics } = await createPaidFetch({
    registry,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    retryCount: 2,
    initialRetryDelay: 100,
  });

  return {
    paidFetch,
    diagnostics,
    fullyConfigured: solanaConfigured && evmConfigured && tempoConfigured,
    config: { solanaConfigured, evmConfigured, tempoConfigured },
  };
}
