// `pay wallet status` — print the same view the MCP wallet_status tool returns.

import { loadRuntimeConfig } from "../../config.ts";
import { addressOf, walletIdOf } from "../../wallet/wallet-registry.ts";

export async function walletStatusCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`pay wallet status — show configured wallets and audit key fingerprint\n`);
    return;
  }
  const config = await loadRuntimeConfig();
  console.log();
  console.log(`agent:        ${config.agent}`);
  console.log(`config:       ${config.configPath ?? "(defaults)"}`);
  console.log(`audit key:    ed25519 ${config.auditKey.publicKeyHex.slice(0, 16)}…`);
  console.log(`catalog:      ${config.defaultCatalog.id}`);
  console.log(`manifest:     ${config.manifestPath}`);
  console.log(`lock:         ${config.lockPath}`);
  console.log();
  const networks = config.registry.networks();
  // Total wallet count = sum of entries across networks.
  const total = networks.reduce(
    (sum, n) => sum + config.registry.entriesFor(n).length,
    0,
  );
  console.log(`wallets (${total}):`);
  if (total === 0) {
    console.log(`  (none — run \`pay wallet init\`)`);
  } else {
    for (const network of networks) {
      const entries = config.registry.entriesFor(network);
      if (entries.length === 1) {
        const e = entries[0]!;
        console.log(`  ${network}  ${walletIdOf(e)}  ${addressOf(e, network) ?? ""}`);
      } else {
        console.log(`  ${network}  (${entries.length} wallets, fallback order):`);
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          const marker = i === 0 ? "→" : " ";
          console.log(`    ${marker} ${walletIdOf(e)}  ${addressOf(e, network) ?? ""}`);
        }
      }
    }
  }
  console.log();
}
