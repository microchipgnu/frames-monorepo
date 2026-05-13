// `createPaidFetch` — build a 402-handling fetch from a WalletRegistry.
//
// Pay's `buildHandlers` is descriptor-driven: it takes a (ToolDescriptor,
// WalletEntry) pair and returns the precise handler for that one paid
// call. Right for catalog tool invocations.
//
// But some consumers (notably tick's `web_fetch` tool) need to negotiate
// 402s on URLs that aren't catalog descriptors at all — agent-driven
// fetches against arbitrary endpoints. For those, you want default-mode
// handlers wired up once: "accept USDC on Solana, USDC on Base, MPP on
// Tempo, fall back to free fetch on anything else."
//
// This module builds that. Same WalletRegistry, same wallet entries,
// same dynamic Tempo import — but the output is a single paidFetch
// suitable for `wrap()` consumption, not a per-call handler list.
//
// Use this when:
//   - You're paying for arbitrary URLs (e.g., agent web_fetch)
//   - You don't have a ToolDescriptor in hand
//   - You want "any wallet that can pay" semantics
//
// Use `buildHandlers` + `dispatch` when:
//   - You have a ToolDescriptor with explicit payment.network/protocol
//   - You want descriptor-side fallback (accepts[] walk)
//   - You want pay's audited receipt machinery

import { wrap } from "@faremeter/fetch";
import { createPaymentHandler as createX402EvmHandler } from "@faremeter/payment-evm/exact";
import { createPaymentHandler as createX402SolanaHandler } from "@faremeter/payment-solana/exact";
import { createMPPSolanaChargeClient } from "@faremeter/payment-solana/charge";
import type { PaymentHandler } from "@faremeter/types/client";
import type { MPPPaymentHandler } from "@faremeter/types/mpp";
import type { WalletEntry, WalletRegistry } from "./wallet-registry.ts";

/** USDC mint on Solana mainnet — default when no override is supplied. */
const SOLANA_USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface CreatePaidFetchOptions {
  /** The registry to derive default handlers from. */
  registry: WalletRegistry;
  /**
   * Solana RPC URL — required if any Solana wallet is registered. Used by
   * the x402 Solana handler AND the MPP Solana charge client.
   */
  solanaRpcUrl?: string;
  /**
   * SPL mint to accept Solana payments in. Defaults to USDC mainnet.
   * Pass a different mint if your dataset settles in PYUSD/USDT/etc.
   */
  solanaMint?: string;
  /**
   * EVM asset name to accept. Defaults to "USDC". Passed straight to
   * `@faremeter/payment-evm/exact`'s handler factory.
   */
  evmAsset?: string;
  /** Faremeter wrap()'s retryCount. Default 2. */
  retryCount?: number;
  /** Faremeter wrap()'s initialRetryDelay (ms). Default 100. */
  initialRetryDelay?: number;
}

export interface CreatePaidFetchResult {
  /** Drop-in replacement for global fetch that auto-pays 402s. */
  paidFetch: typeof fetch;
  /** Counts for diagnostic / health surfaces. */
  diagnostics: {
    handlerCount: number;
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
 * Build a paidFetch from the registry's wallet entries. Per-kind defaults:
 *
 *   evm    → x402 (and x402v2) EVM handler accepting `evmAsset` (default USDC)
 *   solana → x402 Solana + MPP Solana charge, both on `solanaMint` (default USDC mainnet)
 *   tempo  → MPP Tempo charge via @frames-ag/payment-tempo (dynamic import)
 *   delegated → SKIPPED here — delegated wallets need pay's dispatcher,
 *               which routes to the provider's HTTP endpoint instead of
 *               wrap()'s 402 dance. Use dispatch() for those.
 *
 * Iterates ALL entries across ALL networks; duplicate kinds just produce
 * additional handlers (wrap() will try them in order on a 402).
 */
export async function createPaidFetch(
  opts: CreatePaidFetchOptions,
): Promise<CreatePaidFetchResult> {
  const handlers: PaymentHandler[] = [];
  const mppHandlers: MPPPaymentHandler[] = [];
  const configured = { evm: false, solana: false, tempo: false };
  const solanaMint = opts.solanaMint ?? SOLANA_USDC_MAINNET;
  const evmAsset = opts.evmAsset ?? "USDC";

  // Walk every entry in the registry. Each entry can contribute 0-N handlers
  // depending on its kind. Same wallet may be referenced from multiple
  // network keys; we de-dupe by tracking labels we've already registered
  // per kind so we don't register the same handler twice.
  const seen = new Set<string>();
  for (const network of opts.registry.networks()) {
    for (const entry of opts.registry.entriesFor(network)) {
      const key = `${entry.kind}:${entry.label}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (entry.kind === "evm") {
        handlers.push(createX402EvmHandler(entry.wallet, { asset: evmAsset }));
        configured.evm = true;
        continue;
      }

      if (entry.kind === "solana") {
        if (!opts.solanaRpcUrl) {
          throw new Error(
            "createPaidFetch: solanaRpcUrl is required when a Solana wallet is registered",
          );
        }
        // The faremeter Solana wallet shape and our structural
        // SolanaWalletShape are compatible; cast to satisfy the types.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handlers.push(createX402SolanaHandler(entry.wallet as any, solanaMint as any));
        mppHandlers.push(
          createMPPSolanaChargeClient({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wallet: entry.wallet as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mint: solanaMint as any,
            rpc: opts.solanaRpcUrl,
            broadcast: true,
          }),
        );
        configured.solana = true;
        continue;
      }

      if (entry.kind === "tempo") {
        mppHandlers.push(await loadTempoMppHandler(entry));
        configured.tempo = true;
        continue;
      }

      // Delegated wallets are intentionally skipped — see header.
    }
  }

  const paidFetch = wrap(fetch as typeof fetch, {
    handlers,
    mppHandlers,
    retryCount: opts.retryCount ?? 2,
    initialRetryDelay: opts.initialRetryDelay ?? 100,
  }) as typeof fetch;

  return {
    paidFetch,
    diagnostics: {
      handlerCount: handlers.length,
      mppHandlerCount: mppHandlers.length,
      configured,
    },
  };
}

/**
 * Lazy-load `@frames-ag/payment-tempo` for the MPP Tempo charge client.
 * Mirrors the dynamic-import pattern in `faremeter-bridge.ts` so users
 * without Tempo needs don't pull the package.
 */
async function loadTempoMppHandler(
  entry: Extract<WalletEntry, { kind: "tempo" }>,
): Promise<MPPPaymentHandler> {
  try {
    // String literal hidden in a variable so tsc doesn't try to resolve
    // types at compile time — package is an optionalDependency.
    const pkg = "@frames-ag/payment-tempo";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(/* @vite-ignore */ pkg)) as {
      createMPPTempoChargeClient: (args: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        account: any;
        mode?: "push" | "pull";
        clientId?: string;
      }) => MPPPaymentHandler;
    };
    return mod.createMPPTempoChargeClient({ account: entry.account });
  } catch {
    throw new Error(
      "createPaidFetch: Tempo wallet registered but @frames-ag/payment-tempo is not installed. " +
        "Install it: bun add @frames-ag/payment-tempo",
    );
  }
}
