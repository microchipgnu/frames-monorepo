// Network → faremeter wallet registry.
//
// Pay's whole "BYO wallet" story lives here: the registry holds whatever
// faremeter-shaped wallet objects the user configured (OWS vault, local
// EVM key, Crossmint, Squads, future remote-signer, etc.) keyed by the
// network string we'll see in descriptor.payment.network.

import type { Account } from "viem";
import type { EvmWallet } from "@faremeter/wallet-evm";

/**
 * Structural Solana wallet shape — matches what `@faremeter/wallet-solana`,
 * `@faremeter/wallet-crossmint`, `@faremeter/wallet-ows` (Solana mode), and
 * `@faremeter/wallet-solana-squads` all produce. Typed structurally so we
 * don't have to depend on @solana/web3.js or @solana/kit at the registry
 * level — payment-solana handles the actual signing semantics.
 */
export interface SolanaWalletShape {
  network: string;
  publicKey: { toBase58(): string };
  partiallySignTransaction: (tx: unknown) => Promise<unknown>;
  updateTransaction: (tx: unknown) => Promise<unknown>;
}

/** Discriminated union — different wallet shapes per chain family. */
export type WalletEntry =
  | {
      kind: "evm";
      /** faremeter EVM wallet (works with payment-evm/exact). */
      wallet: EvmWallet;
      /** Loader-supplied identifier, recorded in receipts as `wallet_id`. */
      label: string;
      /** Loader-supplied identifier of the source kind (e.g. "evm", "ows", "crossmint"). */
      source: string;
    }
  | {
      kind: "solana";
      /** faremeter Solana wallet (works with payment-solana/exact + /charge). */
      wallet: SolanaWalletShape;
      label: string;
      source: string;
    }
  | {
      kind: "tempo";
      /** Viem account for MPP Tempo charge (works with payment-tempo). */
      account: Account;
      label: string;
      /** Address in Tempo's hex format. */
      address: `0x${string}`;
      source: string;
    }
  | {
      /**
       * "Delegated" wallets: pay does NOT call faremeter for these. Instead,
       * pay forwards the entire request to a remote provider's HTTP endpoint
       * which handles 402 detection + signing + retry server-side, and pay
       * just records the receipt from the response.
       *
       * Used for hosted wallets like agentwallet (frames.ag), where keys
       * never leave the provider's side.
       */
      kind: "delegated";
      provider: "agentwallet";
      baseUrl: string;
      apiToken: string;
      username: string;
      /** Provider-reported addresses (for receipts when settlement metadata is sparse). */
      addresses: { evm?: string; solana?: string };
      label: string;
      source: string;
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
    if (e.kind === "solana") return e.wallet.publicKey.toBase58();
    if (e.kind === "delegated") {
      // Pick the address matching the network family; the wallet has both.
      if (network === "solana" || network.startsWith("solana")) return e.addresses.solana;
      return e.addresses.evm;
    }
    return undefined;
  }

  /** Human-readable label, used to construct wallet_id in receipts. */
  walletId(network: string): string | undefined {
    const e = this.forNetwork(network);
    if (!e) return undefined;
    // Format: <source>:<label> — source captures the loader (ows, crossmint, evm)
    // so receipts say "ows:my-vault" rather than the chain-family kind.
    return `${e.source}:${e.label}`;
  }
}
