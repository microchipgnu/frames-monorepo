#!/usr/bin/env bun
// Generate a fresh Base Sepolia EVM keypair for the smoke test.
// Saves to examples/smoke/.wallet (gitignored).
// Prints the address so you can fund it from a Sepolia faucet.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_PATH = resolve(__dirname, ".wallet");

let privateKey: `0x${string}`;
if (existsSync(WALLET_PATH)) {
  privateKey = readFileSync(WALLET_PATH, "utf8").trim() as `0x${string}`;
  console.log("Reusing existing wallet at examples/smoke/.wallet");
} else {
  privateKey = generatePrivateKey();
  writeFileSync(WALLET_PATH, privateKey, { mode: 0o600 });
  console.log("Generated new wallet → examples/smoke/.wallet (gitignored, mode 0600)");
}

const account = privateKeyToAccount(privateKey);

console.log();
console.log("=".repeat(70));
console.log(" Base Sepolia smoke wallet");
console.log("=".repeat(70));
console.log(`  Address: ${account.address}`);
console.log();
console.log(" Fund this address with Base Sepolia ETH + USDC:");
console.log(`   1. ETH (for gas) — https://www.alchemy.com/faucets/base-sepolia`);
console.log(`      Just paste ${account.address}, claim 0.5 ETH (free).`);
console.log(`   2. USDC — Coinbase Sepolia faucet`);
console.log(`      https://faucet.circle.com/  → pick "Base Sepolia"`);
console.log(`      Paste ${account.address}, claim 10 USDC (free).`);
console.log();
console.log(" Then run:  bun smoke:settle");
console.log("=".repeat(70));
