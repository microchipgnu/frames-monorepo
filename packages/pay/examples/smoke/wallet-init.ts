#!/usr/bin/env bun
// Stage 3 smoke: run `pay wallet init` against a fake HOME, verify the
// resulting config.yaml is valid, that loadRuntimeConfig parses it, and
// that the resulting WalletRegistry contains a wallet for the chosen network.

import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve as pathResolve } from "node:path";

const fakeHome = mkdtempSync(join(tmpdir(), "pay-init-"));
let exitCode = 0;
try {
  const cliPath = pathResolve(import.meta.dir, "../../src/cli/bin.ts");
  const result = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      "wallet",
      "init",
      "--network",
      "base-sepolia",
      "--label",
      "stage3-smoke",
    ],
    { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.log("✗ pay wallet init exited", result.status);
    console.log(result.stdout);
    console.log(result.stderr);
    exitCode = 1;
  } else {
    console.log(result.stdout);
  }

  const configPath = join(fakeHome, ".frames", "pay", "config.yaml");
  const auditKeyPath = join(fakeHome, ".frames", "pay", "audit-key.json");

  // Asserts
  console.log("Assertions:");
  if (existsSync(configPath)) {
    const mode = (statSync(configPath).mode & 0o777).toString(8);
    console.log(`  ✓ config.yaml exists (mode ${mode})`);
    if (mode !== "600") {
      console.log(`  ✗ expected mode 600, got ${mode}`);
      exitCode = 1;
    }
    const text = readFileSync(configPath, "utf8");
    if (text.includes("kind: evm") && text.includes("base-sepolia")) {
      console.log(`  ✓ config has evm wallet on base-sepolia`);
    } else {
      console.log(`  ✗ config missing expected fields`);
      exitCode = 1;
    }
  } else {
    console.log(`  ✗ config.yaml not created`);
    exitCode = 1;
  }
  if (existsSync(auditKeyPath)) {
    console.log(`  ✓ audit-key.json exists`);
  } else {
    console.log(`  ✗ audit-key.json not created`);
    exitCode = 1;
  }

  // Round-trip: load it via loadRuntimeConfig (pass the explicit path
  // since DEFAULT_CONFIG_PATH was captured from real HOME at module load).
  const { loadRuntimeConfig } = await import("../../src/config.ts");
  const cfg = await loadRuntimeConfig(configPath);
  if (cfg.registry.networks().includes("base-sepolia")) {
    console.log(`  ✓ loadRuntimeConfig sees base-sepolia wallet`);
    console.log(`    address: ${cfg.registry.addressFor("base-sepolia")}`);
  } else {
    console.log(`  ✗ loadRuntimeConfig does not see base-sepolia wallet`);
    exitCode = 1;
  }

  // --force respected
  console.log(`\nVerifying --force overwrite…`);
  const result2 = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      "wallet",
      "init",
      "--network",
      "base-sepolia",
      "--label",
      "different-label",
    ],
    { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
  );
  if (result2.status === 0) {
    console.log(`  ✗ second init without --force should have failed`);
    exitCode = 1;
  } else {
    console.log(`  ✓ second init without --force exits non-zero`);
  }

  const result3 = spawnSync(
    "bun",
    ["run", cliPath, "wallet", "init", "--network", "base-sepolia", "--force"],
    { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
  );
  if (result3.status !== 0) {
    console.log(`  ✗ --force second init failed unexpectedly: ${result3.stderr}`);
    exitCode = 1;
  } else {
    console.log(`  ✓ --force second init succeeds`);
  }

  console.log();
  if (exitCode === 0) console.log("✓ Stage 3 wallet init UX works");
  else console.log("✗ Stage 3 smoke had failures");
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}
process.exit(exitCode);
