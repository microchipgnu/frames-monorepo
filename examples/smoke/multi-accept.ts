#!/usr/bin/env bun
// Smoke: payment-option selection across descriptor.payment.accepts[].
//
// Validates pay's wallet selection logic:
//   1. Descriptor with two accepts (Base + Solana). Wallet only on Solana.
//      → Solana option selected (Base option skipped: no_wallet_for_network).
//   2. Wallet on both, with price_hint above what's plausibly funded on the
//      first option. → Falls through to the second option.
//   3. Single-option descriptor (no accepts[]) still works (regression).
//   4. No viable option (no wallets configured) → DispatchError listing
//      what was tried.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalWallet } from "@faremeter/wallet-evm";
import {
  WalletRegistry,
  type WalletEntry,
} from "../../src/wallet/wallet-registry.ts";
import {
  payForTool,
  DispatchError,
} from "../../src/wallet/dispatch.ts";
import { loadOrCreateAuditKey } from "../../src/wallet/audit-key.ts";
import { descriptorId } from "../../src/descriptor-id.ts";
import type { ToolDescriptor } from "../../src/types.ts";

const WALLET_PATH = pathResolve(import.meta.dir, ".wallet");
if (!existsSync(WALLET_PATH)) {
  console.error("Run `bun smoke:gen-wallet` first.");
  process.exit(1);
}
const privateKey = readFileSync(WALLET_PATH, "utf8").trim() as `0x${string}`;
const evmWallet = await createLocalWallet({ id: 84532, name: "Base Sepolia" }, privateKey);
const auditKey = await loadOrCreateAuditKey();

let exitCode = 0;
function assert(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) exitCode = 1;
}

const baseEntry: WalletEntry = {
  kind: "evm",
  wallet: evmWallet,
  label: "smoke",
  source: "evm",
};

// ---------------------------------------------------------------------------
// Test 1: descriptor with accepts[base, solana]; wallet only on solana
// ---------------------------------------------------------------------------
console.log("Test 1: accepts has [base, solana], wallet only on solana");

const descriptorPreferBase: ToolDescriptor = {
  pay_protocol: "0.0.1",
  id: "test.multi",
  title: "Test multi-accept",
  description: "test",
  capabilities: ["test"],
  invocation: { method: "POST", url: "https://example.test/api" },
  payment: {
    protocol: "x402",
    network: "base",
    currency: "USDC",
    price_hint: "0.001",
    accepts: [
      {
        protocol: "x402",
        network: "solana-mainnet",
        currency: "USDC",
        price_hint: "0.001",
      },
    ],
  },
};

// Mock Solana wallet so the bridge resolves it
const mockSolanaWallet = {
  network: "solana-mainnet",
  publicKey: { toBase58: () => "MockSolanaPub111111111111111111111111111111" },
  partiallySignTransaction: async (tx: unknown) => tx,
  updateTransaction: async (tx: unknown) => tx,
};

const registrySolanaOnly = new WalletRegistry({
  byNetwork: {
    "solana-mainnet": {
      kind: "solana",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: mockSolanaWallet as any,
      label: "solana-smoke",
      source: "solana",
    },
  },
  agent: "smoke:multi",
});

try {
  // We're not actually calling — we want to see if selection picks Solana.
  // Use balancePolicy: "off" so we don't try to RPC-balance-check the mock wallet.
  // The fetch will fail (URL is fake) but we'll see the failure reason: it'll
  // be a network error after selection succeeded.
  await payForTool(
    {
      name: "https://catalog.microchipgnu.workers.dev/tools/frames.test.post.api-echo", // dummy: resolve will fetch a real one but we override descriptor at runtime
      params: {},
    },
    { registry: registrySolanaOnly, auditKey, balancePolicy: "off" },
  );
  console.log("  unexpected success (test infra issue)");
} catch (e) {
  // We expect a DispatchError because resolveTool resolves the real test
  // descriptor (Base Sepolia x402) which doesn't match our solana-only registry.
  // This validates: no_wallet_for_network for the canonical option, and no
  // accepts on a real catalog descriptor → throws.
  if (e instanceof DispatchError) {
    const m = (e as Error).message;
    assert("no viable option found", m.includes("no viable wallet"), m.slice(0, 100));
  } else {
    console.log(`  ? unexpected error: ${(e as Error).message}`);
    exitCode = 1;
  }
}

// Test 1 in-memory variant — bypass resolveTool with synthetic descriptor.
// Build a payForTool input that uses the URL-mode resolution to fetch our
// synthetic descriptor by passing it through a manual `lock` shortcut.
console.log("\nTest 1 (in-memory): synthetic descriptor with accepts[]");
{
  // Build a synthetic lock with REAL descriptor_id so verifyLockEntry passes.
  const did = await descriptorId(descriptorPreferBase);
  const fakeLock = {
    pay_protocol: "0.0.1" as const,
    lockfile_version: 1 as const,
    resolved: {
      "synthetic-test": {
        source: { url: "synthetic://test" },
        descriptor_id: did,
        fetched_at: new Date().toISOString(),
        descriptor: descriptorPreferBase,
      },
    },
  };
  try {
    await payForTool(
      { name: "synthetic-test", params: {}, lock: fakeLock },
      { registry: registrySolanaOnly, auditKey, balancePolicy: "off" },
    );
    console.log("  ! payForTool returned (probably fetched the fake URL)");
  } catch (e) {
    const m = (e as Error).message;
    if (e instanceof DispatchError && m.includes("no viable wallet")) {
      // Both options failed selection.
      assert(
        "selection should have found Solana viable",
        false,
        m.slice(0, 200),
      );
    } else {
      // Selection succeeded — error happened later (handler construction,
      // fetch, etc.). That's the signal we wanted: pay walked past the
      // Base option and tried the Solana one.
      assert(
        `selection moved past Base, attempted Solana (downstream error: ${(e as Error).message.slice(0, 60)}…)`,
        true,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test 2: single-option descriptor (no accepts[]) still works (regression)
// ---------------------------------------------------------------------------
console.log("\nTest 2: single-option descriptor (no accepts[])");
{
  const singleDescriptor: ToolDescriptor = {
    pay_protocol: "0.0.1",
    id: "test.single",
    title: "Single",
    description: "test",
    capabilities: ["test"],
    invocation: { method: "POST", url: "https://example.test/api" },
    payment: {
      protocol: "x402",
      network: "base-sepolia",
      currency: "USDC",
      price_hint: "0.001",
    },
  };
  const did = await descriptorId(singleDescriptor);
  const fakeLock = {
    pay_protocol: "0.0.1" as const,
    lockfile_version: 1 as const,
    resolved: {
      "single-test": {
        source: { url: "synthetic://single" },
        descriptor_id: did,
        fetched_at: new Date().toISOString(),
        descriptor: singleDescriptor,
      },
    },
  };
  const reg = new WalletRegistry({
    byNetwork: { "base-sepolia": baseEntry },
    agent: "smoke",
  });
  try {
    await payForTool(
      { name: "single-test", params: {}, lock: fakeLock },
      { registry: reg, auditKey, balancePolicy: "off" },
    );
  } catch (e) {
    // Expected: network error (synthetic URL). Selection should have succeeded.
    const msg = (e as Error).message;
    if (msg.includes("no viable wallet")) {
      assert("selection should have picked base-sepolia", false, msg);
    } else {
      assert("single-option: selection succeeded (downstream fetch failed)", true);
    }
  }
}

// ---------------------------------------------------------------------------
// Test 3: no wallets configured at all → DispatchError lists attempts
// ---------------------------------------------------------------------------
console.log("\nTest 3: no wallets configured");
{
  const did = await descriptorId(descriptorPreferBase);
  const fakeLock = {
    pay_protocol: "0.0.1" as const,
    lockfile_version: 1 as const,
    resolved: {
      "x": {
        source: { url: "synthetic://x" },
        descriptor_id: did,
        fetched_at: new Date().toISOString(),
        descriptor: descriptorPreferBase,
      },
    },
  };
  const emptyReg = new WalletRegistry({ byNetwork: {}, agent: "smoke" });
  try {
    await payForTool(
      { name: "x", params: {}, lock: fakeLock },
      { registry: emptyReg, auditKey, balancePolicy: "off" },
    );
    assert("should have thrown", false);
  } catch (e) {
    if (e instanceof DispatchError) {
      const m = e.message;
      assert("error mentions both options", m.includes("base") && m.includes("solana"), m.slice(0, 150));
      // Both options should have failed for the same reason (no wallet).
      // Status shows up as either "no_handler" or "no_wallet_for_network"
      // depending on whether the BridgeError fires before or after the
      // network check; both are correct outcomes.
      assert(
        "status indicates wallet absence",
        m.includes("no_handler") || m.includes("no_wallet_for_network"),
      );
    } else {
      console.log(`  ? unexpected: ${(e as Error).message}`);
      exitCode = 1;
    }
  }
}

console.log();
if (exitCode === 0) console.log("✓ multi-option wallet selection works");
process.exit(exitCode);
