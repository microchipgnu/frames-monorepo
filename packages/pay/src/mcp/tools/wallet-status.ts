// wallet_status — list configured wallets per network with balances for the
// rails this monorepo's tools typically settle on (USDC; CASH on Solana).
//
// Balances exist so a discover/curate run can fail FAST in preflight when a
// wallet is configured but unfunded — instead of running the full plan and
// hitting `agentwallet 500` mid-flight. Verified 2026-05-25: layoffs-2026
// discover run consumed 3 paid attempts before surfacing that the base
// wallet was empty.

import type { RuntimeConfig } from "../../config.ts";
import { renderWalletStatus } from "../../wallet/status.ts";

export const walletStatusSchema = {
  name: "wallet_status",
  description:
    "Show configured wallets per network, agent identity, audit key fingerprint, config path, and (by default) the wallet balance in the rail's primary stablecoin. Set include_balances=false to skip the on-chain balance reads.",
  inputSchema: {
    type: "object",
    properties: {
      include_balances: {
        type: "boolean",
        description:
          "Probe each wallet's balance in USDC (and CASH on Solana). Default true. Set false for an offline-only summary.",
      },
    },
  },
};

export async function walletStatusHandler(
  args: unknown,
  config: RuntimeConfig,
) {
  const includeBalances = (() => {
    if (args && typeof args === "object" && "include_balances" in args) {
      const v = (args as { include_balances?: unknown }).include_balances;
      if (typeof v === "boolean") return v;
    }
    return true;
  })();

  const text = await renderWalletStatus(config, {
    includeBalances,
    configFallback: "(defaults — no ~/.frames/pay/config.yaml)",
    emptyHint: `(none configured — edit ${config.configPath ?? "~/.frames/pay/config.yaml"} → wallets)`,
  });

  return { content: [{ type: "text" as const, text }] };
}
