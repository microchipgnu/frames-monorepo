// descriptor.payment.protocol → faremeter handler factory.
//
// Pay's ENTIRE protocol-pluggability is this one switch statement.
// New protocols light up by adding a case; pay's library otherwise
// stays unchanged.

import { createPaymentHandler as createX402EvmHandler } from "@faremeter/payment-evm/exact";
import { createPaymentHandler as createX402SolanaHandler } from "@faremeter/payment-solana/exact";
import type { PaymentHandler } from "@faremeter/types/client";
import type { MPPPaymentHandler } from "@faremeter/types/mpp";
import type { ToolDescriptor } from "../types.ts";
import type { WalletEntry, WalletRegistry } from "./wallet-registry.ts";

// Known SPL mint fallbacks per network. Used when descriptor.payment.asset
// is absent (older catalog descriptors that didn't preserve the mint during
// refresh). Refresh script v2 should populate the asset field directly.
const KNOWN_SPL_MINTS: Record<string, string> = {
  // Solana mainnet USDC
  "solana-mainnet": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // Solana devnet USDC (used by registry.frames.ag's test endpoint)
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeOutput {
  handlers: PaymentHandler[];
  mppHandlers: MPPPaymentHandler[];
  /** True when descriptor.payment.protocol is "none" — caller should bypass faremeter wrap. */
  free: boolean;
  /** The wallet entry that was selected (for receipt fields). null when free. */
  walletEntry: WalletEntry | null;
}

export function buildHandlers(
  descriptor: ToolDescriptor,
  registry: WalletRegistry,
): BridgeOutput {
  const proto = descriptor.payment.protocol;

  // Free path — no payment, but pay still does dispatch + audit.
  if (proto === "none") {
    return { handlers: [], mppHandlers: [], free: true, walletEntry: null };
  }

  // Delegated path — provider-side signing. Bridge returns no handlers; the
  // dispatcher will detect the wallet kind and route to the provider's HTTP
  // endpoint instead of using faremeter's wrap.
  const network = descriptor.payment.network;
  if (network) {
    const probe = registry.forNetwork(network);
    if (probe?.kind === "delegated") {
      return { handlers: [], mppHandlers: [], free: false, walletEntry: probe };
    }
  }

  if (!network) {
    throw new BridgeError(
      `descriptor ${descriptor.id} has no payment.network (required for protocol=${proto})`,
    );
  }
  const entry = registry.forNetwork(network);
  if (!entry) {
    throw new BridgeError(
      `no wallet configured for network "${network}" (required by ${descriptor.id}). ` +
        `Configured networks: [${registry.networks().join(", ")}]`,
    );
  }

  // x402 / x402v2 on EVM — proven path.
  if ((proto === "x402" || proto === "x402v2") && entry.kind === "evm") {
    return {
      handlers: [createX402EvmHandler(entry.wallet)],
      mppHandlers: [],
      free: false,
      walletEntry: entry,
    };
  }

  // x402 / x402v2 on Solana — uses payment-solana/exact, requires SPL mint.
  if ((proto === "x402" || proto === "x402v2") && entry.kind === "solana") {
    const mint = pickSolanaMint(descriptor, network);
    if (!mint) {
      throw new BridgeError(
        `descriptor ${descriptor.id} for Solana x402 needs payment.asset (SPL mint). ` +
          `Known fallbacks: ${Object.keys(KNOWN_SPL_MINTS).join(", ")}`,
      );
    }
    // The faremeter Solana wallet shape and our SolanaWalletShape are
    // structurally compatible; cast to satisfy the type constraint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = createX402SolanaHandler(entry.wallet as any, mint as any);
    return {
      handlers: [handler],
      mppHandlers: [],
      free: false,
      walletEntry: entry,
    };
  }

  // MPP Tempo charge — uses sibling @frames-ag/payment-tempo package
  // when present. We dynamic-import to keep it optional.
  if (proto === "mpp" && entry.kind === "tempo") {
    throw new BridgeError(
      `MPP Tempo handler requires @frames-ag/payment-tempo to be installed and ` +
        `wired into bridge. Not yet integrated in v0.0.1.`,
    );
  }

  throw new BridgeError(
    `no handler for protocol=${proto} on network=${network} ` +
      `(wallet kind=${entry.kind}). Supported in v0.0.1: x402/x402v2 on EVM, ` +
      `x402/x402v2 on Solana.`,
  );
}

function pickSolanaMint(
  descriptor: ToolDescriptor,
  network: string,
): string | undefined {
  // Prefer descriptor.payment.asset (the authoritative field per SPEC).
  const asset = descriptor.payment.asset;
  if (typeof asset === "string" && asset.length > 0) return asset;
  // Fall back to known mints per normalized network name.
  return KNOWN_SPL_MINTS[network];
}
