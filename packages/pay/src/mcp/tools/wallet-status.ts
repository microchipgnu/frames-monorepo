// wallet_status — list configured wallets per network and the audit key fingerprint.

import type { RuntimeConfig } from "../../config.ts";
import { addressOf, walletIdOf } from "../../wallet/wallet-registry.ts";

export const walletStatusSchema = {
  name: "wallet_status",
  description:
    "Show configured wallets per network, agent identity, audit key fingerprint, and config path.",
  inputSchema: { type: "object", properties: {} },
};

export async function walletStatusHandler(
  _args: unknown,
  config: RuntimeConfig,
) {
  const networks = config.registry.networks();
  const total = networks.reduce(
    (sum, n) => sum + config.registry.entriesFor(n).length,
    0,
  );
  const lines: string[] = [
    `agent:        ${config.agent}`,
    `config:       ${config.configPath ?? "(defaults — no ~/.frames/pay/config.yaml)"}`,
    `audit key:    ed25519 ${config.auditKey.publicKeyHex.slice(0, 16)}…`,
    `catalog:      ${config.defaultCatalog.id}`,
    `manifest:     ${config.manifestPath}`,
    `lock:         ${config.lockPath}`,
    "",
    `wallets (${total}):`,
  ];
  if (total === 0) {
    lines.push(`  (none configured — edit ${config.configPath ?? "~/.frames/pay/config.yaml"} → wallets)`);
  } else {
    for (const network of networks) {
      const entries = config.registry.entriesFor(network);
      if (entries.length === 1) {
        const e = entries[0]!;
        lines.push(`  ${network}  ${walletIdOf(e)}  ${addressOf(e, network) ?? ""}`);
      } else {
        lines.push(`  ${network}  (${entries.length} wallets, fallback order):`);
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          const marker = i === 0 ? "→" : " ";
          lines.push(`    ${marker} ${walletIdOf(e)}  ${addressOf(e, network) ?? ""}`);
        }
      }
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
