// Network → faremeter wallet registry.
//
// Pay's whole "BYO wallet" story lives here: the registry holds whatever
// faremeter-shaped wallet objects the user configured (OWS vault, local
// EVM key, Crossmint, Squads, future remote-signer, etc.) keyed by the
// network string we'll see in descriptor.payment.network.
//
// Multiple wallets per network are supported: dispatch tries them in
// declaration order and falls through to the next on failure (no balance,
// signing error, etc.). This mirrors the descriptor-side accepts[]
// fallback walked by selectPaymentOption.

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
  /**
   * Per-network wallet entries. Each network maps to an ordered list of
   * candidates; dispatch tries them in order, falling through to the next
   * on failure. A single-entry list is the common case.
   *
   * For backwards compatibility with the older single-wallet shape, callers
   * may pass a single WalletEntry instead of a list — it's normalized to a
   * one-item array in the constructor.
   */
  byNetwork: Record<string, WalletEntry | WalletEntry[]>;
  /** Default agent identifier baked into receipts (e.g. "claude:opus-4.7"). */
  agent?: string;
}

/**
 * Format an entry's `wallet_id` for receipts: "<source>:<label>".
 * source captures the loader (ows, crossmint, agentcash, …) so receipts
 * say "ows:my-vault" rather than the chain-family kind.
 */
export function walletIdOf(entry: WalletEntry): string {
  return `${entry.source}:${entry.label}`;
}

/**
 * The on-chain address for an entry on the given network. Used for
 * receipt fields and for `wallet status` output.
 */
export function addressOf(
  entry: WalletEntry,
  network: string,
): string | undefined {
  if (entry.kind === "evm") return entry.wallet.address;
  if (entry.kind === "tempo") return entry.address;
  if (entry.kind === "solana") return entry.wallet.publicKey.toBase58();
  if (entry.kind === "delegated") {
    if (network === "solana" || network.startsWith("solana")) return entry.addresses.solana;
    return entry.addresses.evm;
  }
  return undefined;
}

export class WalletRegistry {
  private readonly byNetwork: Record<string, WalletEntry[]>;
  private readonly agentName: string;

  constructor(config: WalletRegistryConfig) {
    this.byNetwork = {};
    for (const [network, entryOrList] of Object.entries(config.byNetwork)) {
      this.byNetwork[network] = Array.isArray(entryOrList)
        ? entryOrList
        : [entryOrList];
    }
    this.agentName = config.agent ?? "system:cli";
  }

  /** All entries for a network, in declaration order. */
  entriesFor(network: string): WalletEntry[] {
    return this.byNetwork[network] ?? [];
  }

  /**
   * Primary (first) entry for a network. Kept for back-compat callers that
   * don't yet care about multi-wallet fallback (e.g., single-wallet display).
   */
  forNetwork(network: string): WalletEntry | undefined {
    return this.byNetwork[network]?.[0];
  }

  agent(): string {
    return this.agentName;
  }

  /** All configured network identifiers. */
  networks(): string[] {
    return Object.keys(this.byNetwork);
  }

  /** Address of the primary entry for a network. */
  addressFor(network: string): string | undefined {
    const e = this.forNetwork(network);
    return e ? addressOf(e, network) : undefined;
  }

  /** wallet_id of the primary entry for a network. */
  walletId(network: string): string | undefined {
    const e = this.forNetwork(network);
    return e ? walletIdOf(e) : undefined;
  }
}
