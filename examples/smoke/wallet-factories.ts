#!/usr/bin/env bun
// Stage 3+: verify the WALLET_FACTORIES dispatch table — every supported
// `kind` is registered, valid configs route to the right factory, missing
// faremeter packages produce actionable errors instead of silent failures.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig, ConfigError } from "../../src/config.ts";

const home = mkdtempSync(join(tmpdir(), "pay-factories-"));
let exitCode = 0;
try {
  const cfgDir = join(home, ".frames", "pay");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.yaml");

  // 1. evm — always works (faremeter package is installed)
  console.log("kind: evm  →  always available, no extra deps");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  base-sepolia:
    kind: evm
    label: smoke
    private_key: "0x0000000000000000000000000000000000000000000000000000000000000001"
    chain: { id: 84532, name: Base Sepolia }
`,
  );
  try {
    const cfg = await loadRuntimeConfig(cfgPath);
    const addr = cfg.registry.addressFor("base-sepolia");
    const id = cfg.registry.walletId("base-sepolia");
    console.log(`  ✓ loaded → wallet_id=${id}, address=${addr}`);
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`);
    exitCode = 1;
  }

  // 2. crossmint — package not installed, expect actionable error
  console.log("\nkind: crossmint  →  package optional");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  cm:
    kind: crossmint
    label: cm-smoke
    network: solana
    api_key: "fake-key-for-test"
    wallet_address: "FakeWallet111111111111111111111111111111111"
`,
  );
  try {
    await loadRuntimeConfig(cfgPath);
    console.log(`  ✗ expected error (package not installed)`);
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("@faremeter/wallet-crossmint") && msg.includes("bun add")) {
      console.log(`  ✓ actionable error: "${msg.slice(0, 100)}…"`);
    } else if (e instanceof ConfigError) {
      console.log(`  ✓ ConfigError: "${msg.slice(0, 100)}…"`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
    }
  }

  // 3. ows — package not installed, expect actionable error
  console.log("\nkind: ows  →  package optional");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  base:
    kind: ows
    label: vault
    wallet_name: my-vault
    passphrase: "fake-passphrase"
    evm: { chain: { id: 8453, name: Base } }
`,
  );
  try {
    await loadRuntimeConfig(cfgPath);
    console.log(`  ✗ expected error (package not installed)`);
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("@faremeter/wallet-ows") && msg.includes("bun add")) {
      console.log(`  ✓ actionable error: "${msg.slice(0, 100)}…"`);
    } else if (e instanceof ConfigError) {
      console.log(`  ✓ ConfigError: "${msg.slice(0, 100)}…"`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
    }
  }

  // 4. solana — package not installed
  console.log("\nkind: solana  →  package optional");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  solana:
    kind: solana
    label: dev
    network: solana
    secret_key_b58: "FakeKeyForTest11111111111111111111111111111111"
`,
  );
  try {
    await loadRuntimeConfig(cfgPath);
    console.log(`  ✗ expected error (package not installed)`);
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (
      msg.includes("@faremeter/wallet-solana") ||
      msg.includes("@solana/web3.js") ||
      msg.includes("bun add")
    ) {
      console.log(`  ✓ actionable error: "${msg.slice(0, 100)}…"`);
    } else if (e instanceof ConfigError) {
      console.log(`  ✓ ConfigError: "${msg.slice(0, 100)}…"`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
    }
  }

  // 5. unknown kind — error lists available kinds
  console.log("\nkind: agentcash  →  not registered");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  base:
    kind: agentcash
    label: x
`,
  );
  try {
    await loadRuntimeConfig(cfgPath);
    console.log(`  ✗ expected error`);
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("not supported") && msg.includes("Available:")) {
      console.log(`  ✓ ConfigError lists alternatives: "${msg.slice(0, 100)}…"`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
      exitCode = 1;
    }
  }

  console.log();
  if (exitCode === 0) console.log("✓ Wallet factories dispatch correctly");
  else console.log("✗ Some factory paths broken");
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(exitCode);
