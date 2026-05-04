// Pre-flight balance reading via faremeter helpers.
//
// Used by:
//   - dispatch.ts before signing a paid call (warn / abort if insufficient)
//   - wallet_status MCP tool / pay wallet status CLI
//
// EVM:    @faremeter/payment-evm/erc20 getTokenBalance({ account, asset, client })
// Solana: @faremeter/payment-solana/splToken getTokenBalance({ asset, account, rpcClient })
// Tempo / delegated: not implemented; caller skips the check
//
// Returns the balance in the smallest unit (wei / lamports / micro-USDC) plus
// decimals. Caller does the human-readable formatting.

import type { ToolDescriptor } from "../types.ts";
import type { WalletEntry } from "./wallet-registry.ts";

export interface BalanceResult {
  amount: bigint;
  decimals: number;
  /** Network the balance was checked on. */
  network: string;
  /** Token contract / mint address that was queried. */
  asset: string;
  /** Human-readable amount, e.g. "12.50". */
  formatted: string;
}

export class BalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}

/**
 * Fetch the on-chain balance for the asset that would be used to settle
 * this descriptor. Returns null when the wallet kind doesn't support balance
 * reads today (delegated / tempo) — caller should treat absence as
 * "skip pre-flight check, proceed".
 */
export async function getBalanceForDescriptor(
  descriptor: ToolDescriptor,
  entry: WalletEntry,
): Promise<BalanceResult | null> {
  const network = descriptor.payment.network;
  if (!network) return null;

  if (entry.kind === "evm") {
    return await getEvmBalance(descriptor, entry);
  }
  if (entry.kind === "solana") {
    return await getSolanaBalance(descriptor, entry);
  }
  // Delegated / Tempo — not yet supported.
  return null;
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

async function getEvmBalance(
  descriptor: ToolDescriptor,
  entry: Extract<WalletEntry, { kind: "evm" }>,
): Promise<BalanceResult | null> {
  const asset = descriptor.payment.asset ?? KNOWN_EVM_USDC[descriptor.payment.network ?? ""];
  if (!asset) return null;

  // Build a viem PublicClient targeting the wallet's chain. We import lazily
  // to keep config.ts loading cheap.
  const viem = await import("viem");
  const chains = await import("viem/chains");

  const chainId = entry.wallet.chain.id;
  const chain = findViemChain(chains, chainId);
  if (!chain) {
    throw new BalanceError(`no viem chain config for chain id ${chainId}`);
  }
  const client = viem.createPublicClient({
    chain,
    transport: viem.http(),
  });

  const erc20 = (await import("@faremeter/payment-evm/erc20")) as {
    getTokenBalance: (args: {
      account: `0x${string}`;
      asset: `0x${string}`;
      client: import("viem").PublicClient;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => Promise<{ amount: bigint; decimals: number }>;
  };
  const { amount, decimals } = await erc20.getTokenBalance({
    account: entry.wallet.address,
    asset: asset as `0x${string}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
  });

  return {
    amount,
    decimals,
    network: descriptor.payment.network ?? "unknown",
    asset,
    formatted: formatUnits(amount, decimals),
  };
}

// USDC token addresses on common EVM networks (fallback when descriptor.payment.asset is absent).
const KNOWN_EVM_USDC: Record<string, string> = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

function findViemChain(
  chains: Record<string, unknown>,
  chainId: number,
): import("viem").Chain | undefined {
  for (const c of Object.values(chains)) {
    if (
      c &&
      typeof c === "object" &&
      "id" in c &&
      (c as { id: unknown }).id === chainId
    ) {
      return c as import("viem").Chain;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

async function getSolanaBalance(
  descriptor: ToolDescriptor,
  entry: Extract<WalletEntry, { kind: "solana" }>,
): Promise<BalanceResult | null> {
  const asset = descriptor.payment.asset;
  if (!asset) return null;

  // Lazy import to keep startup cheap.
  const sol = (await import("@faremeter/payment-solana/splToken")) as {
    getTokenBalance: (args: {
      asset: string;
      account: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rpcClient: any;
      tokenProgram?: string;
    }) => Promise<{ amount: bigint; decimals: number } | null>;
  };
  const { createSolanaRpc } = (await import("@solana/kit")) as {
    createSolanaRpc: (url: string) => unknown;
  };
  const rpcUrl = SOLANA_RPCS[descriptor.payment.network ?? ""] ?? SOLANA_RPCS["solana-mainnet"]!;
  const rpcClient = createSolanaRpc(rpcUrl);
  const result = await sol.getTokenBalance({
    asset,
    account: entry.wallet.publicKey.toBase58(),
    rpcClient,
  });
  if (!result) {
    return {
      amount: 0n,
      decimals: 6,
      network: descriptor.payment.network ?? "solana",
      asset,
      formatted: "0",
    };
  }
  return {
    ...result,
    network: descriptor.payment.network ?? "solana",
    asset,
    formatted: formatUnits(result.amount, result.decimals),
  };
}

const SOLANA_RPCS: Record<string, string> = {
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
  "solana-testnet": "https://api.testnet.solana.com",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const div = 10n ** BigInt(decimals);
  const whole = amount / div;
  const frac = amount % div;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
