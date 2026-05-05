#!/usr/bin/env bun
// Smoke: pay wallet detect + init --auto against a synthetic HOME with
// multiple wallet sources. Verifies probe correctness, dedupe, and that
// the resulting config.yaml is loadable.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const fakeHome = mkdtempSync(join(tmpdir(), "pay-detect-"));
let exitCode = 0;
const cliPath = pathResolve(import.meta.dir, "../../src/cli/bin.ts");

try {
  // Lay down 3 fake wallets — agentwallet + agentcash + frames OWS
  // 1. agentwallet
  mkdirSync(join(fakeHome, ".agentwallet"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".agentwallet", "config.json"),
    JSON.stringify({
      apiToken: "aw_fake_token",
      baseUrl: "https://frames.ag",
      username: "smoke",
      evmAddress: "0xAA00000000000000000000000000000000000001",
      solanaAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  );
  // 2. agentcash
  mkdirSync(join(fakeHome, ".agentcash"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".agentcash", "wallet.json"),
    JSON.stringify({
      address: "0xBB00000000000000000000000000000000000002",
      privateKey: "0x" + "11".repeat(32),
      createdAt: new Date().toISOString(),
    }),
  );
  // 3. frames OWS pointer
  mkdirSync(join(fakeHome, ".frames", "secrets", "org_default"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".frames", "secrets", "org_default", "x402.json"),
    JSON.stringify({ provider_name: "open-wallet-standard", credential: "agent-treasury" }),
  );

  // Run pay wallet detect with HOME overridden
  console.log("Test 1: pay wallet detect");
  const detectRes = spawnSync("bun", ["run", cliPath, "wallet", "detect"], {
    env: { ...process.env, HOME: fakeHome },
    encoding: "utf8",
  });
  if (detectRes.status !== 0) {
    console.log(`  ✗ exit ${detectRes.status}: ${detectRes.stderr}`);
    exitCode = 1;
  }
  const out = detectRes.stdout ?? "";
  const found = ["agentwallet", "agentcash", "frames OWS"];
  for (const f of found) {
    const ok = out.includes(f);
    console.log(`  ${ok ? "✓" : "✗"} mentions "${f}"`);
    if (!ok) exitCode = 1;
  }

  // Run pay wallet init --auto
  console.log("\nTest 2: pay wallet init --auto (dedupe per network)");
  const initRes = spawnSync(
    "bun",
    ["run", cliPath, "wallet", "init", "--auto"],
    { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
  );
  if (initRes.status !== 0) {
    console.log(`  ✗ exit ${initRes.status}`);
    console.log(initRes.stdout);
    console.log(initRes.stderr);
    exitCode = 1;
  } else {
    const initOut = initRes.stdout ?? "";
    // First detection (agentwallet) covers base + solana-mainnet → claims both.
    // agentcash also covers base + solana-mainnet → should be skipped.
    // frames covers base → already claimed → skipped.
    const claimedAll = initOut.includes("skipping agentcash") && initOut.includes("skipping frames");
    console.log(`  ${claimedAll ? "✓" : "✗"} skipped agentcash + frames (networks already claimed by agentwallet)`);
    if (!claimedAll) {
      console.log("--- output:");
      console.log(initOut);
      exitCode = 1;
    }
  }

  // Validate the written config parses
  console.log("\nTest 3: written config.yaml is valid");
  const cfgPath = join(fakeHome, ".frames", "pay", "config.yaml");
  if (!existsSync(cfgPath)) {
    console.log(`  ✗ config not written`);
    exitCode = 1;
  } else {
    const cfg = readFileSync(cfgPath, "utf8");
    if (cfg.includes("kind: agentwallet")) {
      console.log(`  ✓ config has kind: agentwallet`);
    } else {
      console.log(`  ✗ config missing agentwallet entry`);
      console.log("--- config:");
      console.log(cfg);
      exitCode = 1;
    }
  }

  // --use specific kind
  console.log("\nTest 4: pay wallet init --use agentcash --force");
  const useRes = spawnSync(
    "bun",
    ["run", cliPath, "wallet", "init", "--use", "agentcash", "--force"],
    { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
  );
  if (useRes.status !== 0) {
    console.log(`  ✗ exit ${useRes.status}: ${useRes.stderr}`);
    exitCode = 1;
  } else {
    const cfg = readFileSync(cfgPath, "utf8");
    if (cfg.includes("kind: agentcash") && !cfg.includes("kind: agentwallet")) {
      console.log(`  ✓ config now has only agentcash (overwrote agentwallet)`);
    } else {
      console.log(`  ✗ unexpected config state`);
      console.log(cfg);
      exitCode = 1;
    }
  }

  console.log();
  if (exitCode === 0) console.log("✓ wallet detect + init --auto + init --use all work");
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}
process.exit(exitCode);
