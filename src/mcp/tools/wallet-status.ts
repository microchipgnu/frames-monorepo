// wallet_status — list configured wallets per network and the audit key fingerprint.

import type { RuntimeConfig } from "../../config.ts";

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
  const lines: string[] = [
    `agent:        ${config.agent}`,
    `config:       ${config.configPath ?? "(defaults — no ~/.frames/pay/config.yaml)"}`,
    `audit key:    ed25519 ${config.auditKey.publicKeyHex.slice(0, 16)}…`,
    `catalog:      ${config.defaultCatalog.id}`,
    `manifest:     ${config.manifestPath}`,
    `lock:         ${config.lockPath}`,
    "",
    `wallets (${config.registry.networks().length}):`,
  ];
  if (config.registry.networks().length === 0) {
    lines.push(`  (none configured — edit ${config.configPath ?? "~/.frames/pay/config.yaml"} → wallets)`);
  } else {
    for (const network of config.registry.networks()) {
      const id = config.registry.walletId(network);
      const addr = config.registry.addressFor(network);
      lines.push(`  ${network}  ${id}  ${addr}`);
    }
  }
  // Stage 1c will add aggregated balance + recent receipts here.
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
