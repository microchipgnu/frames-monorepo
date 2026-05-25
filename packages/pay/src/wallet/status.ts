// Shared wallet-status renderer for the MCP `wallet_status` tool and the
// `pay wallet status` CLI. Probes per-(entry,currency) balances in parallel
// so callers can see whether a configured wallet is actually fundable before
// kicking off a paid program.

import type { RuntimeConfig } from "../config.ts";
import type { ToolDescriptor } from "../types.ts";
import { addressOf, walletIdOf, type WalletEntry } from "./wallet-registry.ts";
import { getBalanceForDescriptor, type BalanceResult } from "./balance.ts";

interface BalanceProbe {
  currency: string;
  result?: BalanceResult;
  error?: string;
}

// EVM rails settle in USDC almost universally in this monorepo's catalogs;
// Solana rails additionally see CASH. Conservative on purpose — probing is
// network I/O, so we don't fan out across every known stablecoin.
function currenciesForNetwork(network: string): string[] {
  if (network.startsWith("solana")) return ["USDC", "CASH"];
  return ["USDC"];
}

async function probeBalance(
  entry: WalletEntry,
  network: string,
  currency: string,
): Promise<BalanceProbe> {
  // Synthesize a minimal ToolDescriptor — getBalanceForDescriptor only reads
  // descriptor.payment.{network, currency, asset}, so a fake descriptor is
  // fine here. Avoids needing a real catalog lookup just to read a balance.
  const synthetic: ToolDescriptor = {
    pay_protocol: "0.0.1",
    id: `__balance_probe__/${network}/${currency}`,
    title: "balance-probe",
    description: "",
    capabilities: [],
    invocation: { method: "GET", url: "about:blank" },
    payment: { protocol: "x402v2", network, currency },
  };
  try {
    const result = await getBalanceForDescriptor(synthetic, entry);
    if (result === null) return { currency };
    return { currency, result };
  } catch (e) {
    return { currency, error: (e as Error).message };
  }
}

function formatProbes(probes: BalanceProbe[]): string {
  const parts: string[] = [];
  for (const p of probes) {
    if (p.result) {
      parts.push(`${p.result.formatted} ${p.currency}`);
    } else if (p.error) {
      const trunc = p.error.length > 40 ? `${p.error.slice(0, 40)}…` : p.error;
      parts.push(`${p.currency}=err(${trunc})`);
    } else {
      parts.push(`${p.currency}=?`);
    }
  }
  if (parts.length === 0) return "(no probes)";
  return parts.join("  ");
}

export interface RenderWalletStatusOptions {
  includeBalances?: boolean;
  /** Path label fallback when configPath is null. */
  configFallback?: string;
  /** Empty-state hint, varies between MCP tool and CLI command. */
  emptyHint?: string;
}

export async function renderWalletStatus(
  config: RuntimeConfig,
  options: RenderWalletStatusOptions = {},
): Promise<string> {
  const includeBalances = options.includeBalances ?? true;
  const networks = config.registry.networks();
  const total = networks.reduce(
    (sum, n) => sum + config.registry.entriesFor(n).length,
    0,
  );

  // Probe all (entry, currency) pairs in parallel. Each probe owns its own
  // try/catch (see probeBalance) so one unreachable network doesn't blow up
  // the whole render.
  const probes = new Map<string, BalanceProbe[]>();
  if (includeBalances && total > 0) {
    const tasks: Array<Promise<void>> = [];
    for (const network of networks) {
      const entries = config.registry.entriesFor(network);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const key = `${network}/${i}`;
        probes.set(key, []);
        for (const currency of currenciesForNetwork(network)) {
          tasks.push(
            probeBalance(entry, network, currency).then((p) => {
              probes.get(key)!.push(p);
            }),
          );
        }
      }
    }
    await Promise.all(tasks);
  }

  const lines: string[] = [
    `agent:        ${config.agent}`,
    `config:       ${config.configPath ?? options.configFallback ?? "(defaults)"}`,
    `audit key:    ed25519 ${config.auditKey.publicKeyHex.slice(0, 16)}…`,
    `catalog:      ${config.defaultCatalog.id}`,
    `manifest:     ${config.manifestPath}`,
    `lock:         ${config.lockPath}`,
    "",
    `wallets (${total}):`,
  ];

  if (total === 0) {
    lines.push(`  ${options.emptyHint ?? "(none configured)"}`);
    return lines.join("\n");
  }

  for (const network of networks) {
    const entries = config.registry.entriesFor(network);
    if (entries.length === 1) {
      const e = entries[0]!;
      const probed = probes.get(`${network}/0`);
      lines.push(`  ${network}  ${walletIdOf(e)}  ${addressOf(e, network) ?? ""}`);
      if (includeBalances && probed) {
        lines.push(`      ${formatProbes(probed)}`);
      }
    } else {
      lines.push(`  ${network}  (${entries.length} wallets, fallback order):`);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const marker = i === 0 ? "→" : " ";
        const probed = probes.get(`${network}/${i}`);
        lines.push(`    ${marker} ${walletIdOf(e)}  ${addressOf(e, network) ?? ""}`);
        if (includeBalances && probed) {
          lines.push(`        ${formatProbes(probed)}`);
        }
      }
    }
  }

  return lines.join("\n");
}
