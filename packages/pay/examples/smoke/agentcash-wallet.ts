#!/usr/bin/env bun
// Smoke: pay's `kind: agentcash` factory reads ~/.agentcash/wallet.json
// (the file that `npx agentcash@latest accounts` populates) and produces
// a usable faremeter EVM wallet.
//
// Sets up a fake HOME with a fake agentcash wallet so this runs hermetically.

import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadRuntimeConfig, ConfigError } from "../../src/config.ts";

const fakeHome = mkdtempSync(join(tmpdir(), "pay-agentcash-"));
let exitCode = 0;
try {
  // 1. Create a fake agentcash wallet.json under fakeHome
  const acDir = join(fakeHome, ".agentcash");
  mkdirSync(acDir, { recursive: true });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writeFileSync(
    join(acDir, "wallet.json"),
    JSON.stringify(
      { address: account.address, createdAt: new Date().toISOString(), privateKey },
      null,
      2,
    ),
  );
  console.log(`Fake agentcash EVM wallet at ${join(acDir, "wallet.json")}`);
  console.log(`  address: ${account.address}`);

  // 2. Pay config that points at it via kind: agentcash
  const cfgDir = join(fakeHome, ".frames", "pay");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.yaml");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  base-sepolia:
    kind: agentcash
    label: shared
    evm: { chain: { id: 84532, name: Base Sepolia } }
`,
  );

  // 3. Load through pay (override HOME so the agentcash dir resolves correctly)
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const cfg = await loadRuntimeConfig(cfgPath);
    const loadedAddr = cfg.registry.addressFor("base-sepolia");
    const wid = cfg.registry.walletId("base-sepolia");
    if (loadedAddr?.toLowerCase() === account.address.toLowerCase()) {
      console.log(`  ✓ pay loaded the same address: ${loadedAddr}`);
    } else {
      console.log(`  ✗ address mismatch: pay=${loadedAddr}, agentcash=${account.address}`);
      exitCode = 1;
    }
    if (wid === "agentcash:shared") {
      console.log(`  ✓ wallet_id correctly tagged: ${wid}`);
    } else {
      console.log(`  ✗ wallet_id was ${wid}, expected agentcash:shared`);
      exitCode = 1;
    }
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  }

  // 4. Test missing file path
  console.log("\nMissing wallet.json (no agentcash install):");
  rmSync(acDir, { recursive: true, force: true });
  process.env.HOME = fakeHome;
  try {
    await loadRuntimeConfig(cfgPath);
    console.log(`  ✗ expected error`);
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("agentcash EVM wallet not found") && msg.includes("npx agentcash")) {
      console.log(`  ✓ actionable error: "${msg.slice(0, 100)}…"`);
    } else if (e instanceof ConfigError) {
      console.log(`  ✓ ConfigError: ${msg.slice(0, 100)}…`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
      exitCode = 1;
    }
  }
  if (originalHome !== undefined) process.env.HOME = originalHome;

  // 5. Test env var override (X402_PRIVATE_KEY) wins over file
  console.log("\nX402_PRIVATE_KEY env var override:");
  const overrideKey = generatePrivateKey();
  const overrideAddr = privateKeyToAccount(overrideKey).address;
  process.env["X402_PRIVATE_KEY"] = overrideKey;
  process.env.HOME = fakeHome;
  try {
    const cfg = await loadRuntimeConfig(cfgPath);
    const loadedAddr = cfg.registry.addressFor("base-sepolia");
    if (loadedAddr?.toLowerCase() === overrideAddr.toLowerCase()) {
      console.log(`  ✓ X402_PRIVATE_KEY won (no wallet.json present): ${loadedAddr}`);
    } else {
      console.log(`  ✗ env override did not win: ${loadedAddr}`);
      exitCode = 1;
    }
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    delete process.env["X402_PRIVATE_KEY"];
    if (originalHome !== undefined) process.env.HOME = originalHome;
  }

  console.log();
  if (exitCode === 0) console.log("✓ kind: agentcash works");
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}
process.exit(exitCode);
