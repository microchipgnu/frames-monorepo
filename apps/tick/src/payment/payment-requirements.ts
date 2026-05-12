// Build the PaymentRequirements the server quotes in 402 responses.
//
// One `accepts: [...]` entry per (op, network) combination. Today we quote
// a single entry (USDC on Base) because that's the v1 hosted billing rail.
// Adding Solana would mean returning two entries and letting the client pick.

import { DEFAULT_BUDGETS, type Op } from "@frames-ag/tick-types";
import type { Bindings } from "../env";
import type { PaymentRequirements } from "./types";

/**
 * USDC contract on Base (chain id 8453) mainnet.
 * Source: https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
 */
const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Default network when `TICK_PAY_NETWORK` isn't set. Base is the v1 rail because
 * (a) Coinbase CDP supports it, (b) x402-on-Base has the broadest tooling, and
 * (c) gas is cheap.
 */
const DEFAULT_NETWORK = "base";

/**
 * Default max-timeout the server will wait for the client to retry. 90s gives
 * room for slow wallets without holding the connection forever.
 */
const DEFAULT_MAX_TIMEOUT_SECONDS = 90;

/**
 * Convert a USDC decimal string (e.g. "0.15") to the canonical 6-decimal
 * integer-string representation used on Base ("150000"). x402-v2's `amount`
 * field is the smallest unit.
 */
export function usdcToSmallestUnit(decimal: string): string {
  const n = Number(decimal);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid USDC amount: ${decimal}`);
  }
  // 6 decimal places. Round to nearest to avoid floating-point drift.
  return String(Math.round(n * 1_000_000));
}

/**
 * Build the PaymentRequirements for a given op + budget. The result is the
 * canonical entry returned in `accepts[]` on a 402 challenge.
 *
 * Strategy: we charge the op's default budget unless the caller supplied a
 * larger one. `upto` settlement on the server side means we collect at most
 * the budget but typically less.
 *
 * Returns null when the operator hasn't configured `TICK_PAY_TO_ADDRESS` —
 * the caller should fall back to optional verify in that case.
 */
export function buildPaymentRequirements(
  env: Bindings | undefined,
  op: Op,
  budget: string | undefined,
): PaymentRequirements | null {
  if (!env?.TICK_PAY_TO_ADDRESS) return null;

  const network = env.TICK_PAY_NETWORK ?? DEFAULT_NETWORK;
  const asset = env.TICK_PAY_ASSET ?? USDC_BASE_MAINNET;
  const scheme = inferScheme(network);

  const effectiveBudget = budget ?? DEFAULT_BUDGETS[op];
  const amount = usdcToSmallestUnit(effectiveBudget);

  return {
    scheme,
    network,
    amount,
    asset,
    payTo: env.TICK_PAY_TO_ADDRESS,
    maxTimeoutSeconds: env.TICK_PAY_MAX_TIMEOUT_SECONDS
      ? parseInt(env.TICK_PAY_MAX_TIMEOUT_SECONDS, 10)
      : DEFAULT_MAX_TIMEOUT_SECONDS,
  };
}

/**
 * Map network → default x402 scheme.
 *   - EVM-shaped networks → "erc3009" (EIP-3009 transferWithAuthorization)
 *   - Solana → "spl-token" (signed transfer message)
 *   - Tempo → "erc3009" (Tempo is EVM-shaped)
 *
 * Operators can override via `TICK_PAY_SCHEME` if they need a non-default mapping.
 */
function inferScheme(network: string): string {
  if (network === "solana" || network.startsWith("solana-")) return "spl-token";
  return "erc3009";
}
