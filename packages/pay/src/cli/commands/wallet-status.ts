// `pay wallet status` — print the same view the MCP wallet_status tool returns.

import { loadRuntimeConfig } from "../../config.ts";
import { renderWalletStatus } from "../../wallet/status.ts";

export async function walletStatusCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `pay wallet status — show configured wallets, balances, and audit key fingerprint

Options:
  --no-balances    Skip on-chain balance probes (faster, offline-safe)
`,
    );
    return;
  }
  const includeBalances = !args.includes("--no-balances");
  const config = await loadRuntimeConfig();
  const text = await renderWalletStatus(config, {
    includeBalances,
    configFallback: "(defaults)",
    emptyHint: "(none — run `pay wallet init`)",
  });
  console.log();
  console.log(text);
  console.log();
}
