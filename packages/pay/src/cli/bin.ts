#!/usr/bin/env bun
// `pay` CLI entry point.
//
// Subcommands wired today:
//   pay wallet init    — provision a wallet (Stage 3)
//   pay wallet status  — show configured state
//
// Future stages (1c, 4) will add:
//   pay tool <name> --params <json>
//   pay add <url> [--as <name>]
//   pay install / pay update / pay outdated
//   pay catalog list/show
//   pay receipts list
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { walletInitCommand } from "./commands/wallet-init.ts";
import { walletStatusCommand } from "./commands/wallet-status.ts";
import { walletDetectCommand } from "./commands/wallet-detect.ts";

const PKG_VERSION = (() => {
  try {
    const pkgPath = pathResolve(import.meta.dir, "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const sub = argv[1];
  const rest = argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printRoot();
    return;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(PKG_VERSION);
    return;
  }

  if (cmd === "wallet") {
    if (sub === "init") return await walletInitCommand(rest);
    if (sub === "status") return await walletStatusCommand(rest);
    if (sub === "detect") return await walletDetectCommand(rest);
    if (!sub || sub === "--help" || sub === "-h") {
      printWallet();
      return;
    }
    console.error(`unknown subcommand: pay wallet ${sub}`);
    printWallet();
    process.exit(1);
  }

  console.error(`unknown command: pay ${cmd}`);
  printRoot();
  process.exit(1);
}

function printRoot() {
  console.log(`pay v${PKG_VERSION} — buyer-side runtime for paid agent tool calls

Usage:
  pay wallet detect        — find existing wallets in this environment
  pay wallet init [...]    — provision a wallet (fresh, or from detected)
  pay wallet status        — show configured state

For the agent harness side, run pay-mcp instead (the MCP server).
`);
}

function printWallet() {
  console.log(`pay wallet — wallet management

Subcommands:
  pay wallet detect                         — list existing wallets in this environment
  pay wallet init                           — generate a fresh EVM wallet
  pay wallet init --auto                    — add all detected existing wallets
  pay wallet init --use <kind>              — add a specific detected wallet
  pay wallet init --network <n> [--import]  — generate / import explicitly
  pay wallet status                         — show configured state
`);
}

main().catch((e) => {
  console.error(`pay: ${(e as Error).message}`);
  process.exit(1);
});
