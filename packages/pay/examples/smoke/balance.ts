#!/usr/bin/env bun
// Stage 1c smoke: pre-flight balance reading.
// Reads the funded smoke wallet's USDC balance on Base Sepolia
// (no money spent, just a read).

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalWallet } from "@faremeter/wallet-evm";
import {
  WalletRegistry,
  type WalletEntry,
} from "../../src/wallet/wallet-registry.ts";
import { getBalanceForDescriptor } from "../../src/wallet/balance.ts";
import type { ToolDescriptor } from "../../src/types.ts";

const WALLET_PATH = pathResolve(import.meta.dir, ".wallet");
const BASE_SEPOLIA = { id: 84532, name: "Base Sepolia" } as const;

if (!existsSync(WALLET_PATH)) {
  console.error("Run `bun smoke:gen-wallet` first.");
  process.exit(1);
}
const privateKey = readFileSync(WALLET_PATH, "utf8").trim() as `0x${string}`;
const account = privateKeyToAccount(privateKey);
console.log(`Wallet: ${account.address}`);

const evmWallet = await createLocalWallet(BASE_SEPOLIA, privateKey);
const entry: WalletEntry = {
  kind: "evm",
  wallet: evmWallet,
  label: "smoke",
  source: "evm",
};

const descriptor: ToolDescriptor = {
  pay_protocol: "0.0.1",
  id: "test",
  title: "test",
  description: "test",
  capabilities: ["test"],
  invocation: { method: "POST", url: "https://example.test" },
  payment: {
    protocol: "x402",
    network: "base-sepolia",
    currency: "USDC",
    price_hint: "0.001",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

console.log("\nReading USDC balance via @faremeter/payment-evm/erc20…");
const t0 = Date.now();
const bal = await getBalanceForDescriptor(descriptor, entry);
const elapsed = Date.now() - t0;

if (!bal) {
  console.error("✗ balance returned null (unexpected for evm)");
  process.exit(1);
}

console.log(`  network:  ${bal.network}`);
console.log(`  asset:    ${bal.asset.slice(0, 12)}…`);
console.log(`  amount:   ${bal.amount.toString()} (raw)`);
console.log(`  decimals: ${bal.decimals}`);
console.log(`  formatted: ${bal.formatted} USDC`);
console.log(`  elapsed:  ${elapsed}ms`);

const required = parseFloat(descriptor.payment.price_hint!);
const have = parseFloat(bal.formatted);
console.log();
if (have >= required) {
  console.log(`✓ balance check: ${bal.formatted} ≥ ${required} — sufficient`);
} else {
  console.log(`✗ balance check: ${bal.formatted} < ${required} — insufficient`);
}
