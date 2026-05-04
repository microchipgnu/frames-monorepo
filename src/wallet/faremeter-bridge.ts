// descriptor.payment.protocol → faremeter handler factory.
//
// Pay's ENTIRE protocol-pluggability is this one switch statement.
// New protocols light up by adding a case; pay's library otherwise
// stays unchanged.

import { createPaymentHandler as createX402EvmHandler } from "@faremeter/payment-evm/exact";
import { createPaymentHandler as createX402SolanaHandler } from "@faremeter/payment-solana/exact";
import { lookupKnownSPLToken } from "@faremeter/info/solana";
import type { PaymentHandler } from "@faremeter/types/client";
import type { MPPPaymentHandler } from "@faremeter/types/mpp";
import type { ToolDescriptor } from "../types.ts";
import type { WalletEntry, WalletRegistry } from "./wallet-registry.ts";

// Map pay's normalized network names → faremeter's Solana cluster names.
function networkToSolanaCluster(
  network: string,
): "mainnet-beta" | "devnet" | "testnet" | undefined {
  if (network === "solana-mainnet" || network === "solana") return "mainnet-beta";
  if (network === "solana-devnet") return "devnet";
  if (network === "solana-testnet") return "testnet";
  return undefined;
}

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
          `Set descriptor.payment.asset (SPL mint), or ensure descriptor.payment.currency is a known token symbol on a recognized cluster.`,
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
  // 1. Prefer descriptor.payment.asset (authoritative per SPEC; comes
  //    straight from the seller's accepts[].asset on Bazaar entries).
  const asset = descriptor.payment.asset;
  if (typeof asset === "string" && asset.length > 0) return asset;

  // 2. Fall back to faremeter's `@faremeter/info/solana` token registry,
  //    keyed by (cluster, currency-symbol). Covers USDC, PYUSD, USDT,
  //    USDG, USD1, USX, CASH, EURC, JupUSD, USDS, USDtb, USDu, USDGO, FDUSD.
  const cluster = networkToSolanaCluster(network);
  const symbol = descriptor.payment.currency;
  if (cluster && symbol) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const known = lookupKnownSPLToken(cluster, symbol as any);
    if (known) return known.address as string;
  }
  return undefined;
}
