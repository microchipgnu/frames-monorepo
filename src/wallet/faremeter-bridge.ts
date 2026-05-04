// descriptor.payment.protocol → faremeter handler factory.
//
// Pay's ENTIRE protocol-pluggability is this one switch statement.
// New protocols light up by adding a case; pay's library otherwise
// stays unchanged.

import { createPaymentHandler as createX402EvmHandler } from "@faremeter/payment-evm/exact";
import type { PaymentHandler } from "@faremeter/types/client";
import type { MPPPaymentHandler } from "@faremeter/types/mpp";
import type { ToolDescriptor } from "../types.ts";
import type { WalletEntry, WalletRegistry } from "./wallet-registry.ts";

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

  const network = descriptor.payment.network;
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

  // MPP Tempo charge — uses sibling @frames-ag/payment-tempo package
  // when present. We dynamic-import to keep it optional.
  if (proto === "mpp" && entry.kind === "tempo") {
    throw new BridgeError(
      `MPP Tempo handler requires @frames-ag/payment-tempo to be installed and ` +
        `wired into bridge. Not yet integrated in v0.0.1.`,
    );
  }

  // TODO Stage 1c: x402 Solana, MPP Solana, BYOK
  throw new BridgeError(
    `no handler for protocol=${proto} on network=${network} ` +
      `(wallet kind=${entry.kind}). Supported in v0.0.1: x402/x402v2 on EVM.`,
  );
}
