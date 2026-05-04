// Network → faremeter wallet registry.
//
// Pay's whole "BYO wallet" story lives here: the registry holds whatever
// faremeter-shaped wallet objects the user configured (OWS vault, local
// EVM key, Crossmint, Squads, future remote-signer, etc.) keyed by the
// network string we'll see in descriptor.payment.network.

import type { Account } from "viem";
import type { EvmWallet } from "@faremeter/wallet-evm";

/** Discriminated union — different wallet shapes per chain family. */
export type WalletEntry =
  | {
      kind: "evm";
      /** faremeter EVM wallet (works with payment-evm/exact). */
      wallet: EvmWallet;
      /** User-friendly identifier, recorded in receipts as `wallet_id`. */
      label: string;
    }
  | {
      kind: "tempo";
      /** Viem account for MPP Tempo charge (works with payment-tempo). */
      account: Account;
      label: string;
      /** Address in Tempo's hex format. */
      address: `0x${string}`;
    };

export interface WalletRegistryConfig {
  /** Per-network wallet entries. Multiple networks can map to the same wallet object. */
  byNetwork: Record<string, WalletEntry>;
  /** Default agent identifier baked into receipts (e.g. "claude:opus-4.7"). */
  agent?: string;
}

export class WalletRegistry {
  constructor(private readonly config: WalletRegistryConfig) {}

  forNetwork(network: string): WalletEntry | undefined {
    return this.config.byNetwork[network];
  }

  agent(): string {
    return this.config.agent ?? "system:cli";
  }

  /** All configured network identifiers. */
  networks(): string[] {
    return Object.keys(this.config.byNetwork);
  }

  /**
   * Return the faremeter wallet's on-chain address for receipts.
   * For EVM wallets this is the 0x-prefixed checksummed address;
   * for Tempo it's the account address.
   */
  addressFor(network: string): string | undefined {
    const e = this.forNetwork(network);
    if (!e) return undefined;
    if (e.kind === "evm") return e.wallet.address;
    if (e.kind === "tempo") return e.address;
    return undefined;
  }

  /** Human-readable label, used to construct wallet_id in receipts. */
  walletId(network: string): string | undefined {
    const e = this.forNetwork(network);
    if (!e) return undefined;
    return `${e.kind}:${e.label}`;
  }
}
