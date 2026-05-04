// `pay wallet status` — print the same view the MCP wallet_status tool returns.

import { loadRuntimeConfig } from "../../config.ts";

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
  console.log(`wallets (${networks.length}):`);
  if (networks.length === 0) {
    console.log(`  (none — run \`pay wallet init\`)`);
  } else {
    for (const network of networks) {
      console.log(
        `  ${network}  ${config.registry.walletId(network)}  ${config.registry.addressFor(network)}`,
      );
    }
  }
  console.log();
}
