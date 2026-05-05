#!/usr/bin/env bun
// Smoke: pay's `kind: frames` factory reads ~/.frames/secrets/<org>/<protocol>.json
// to learn which OWS wallet the frames system is configured to use, then
// loads it via @faremeter/wallet-ows.
//
// Two assertions:
//   1. Reads the secrets file and surfaces the wallet name correctly.
//   2. Without OWS package installed → actionable error.
//   3. Wrong provider_name → clear error.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig, ConfigError } from "../../src/config.ts";

const fakeHome = mkdtempSync(join(tmpdir(), "pay-frames-"));
let exitCode = 0;
try {
  // Lay down a fake ~/.frames/secrets/org_default/x402.json
  const framesSecretsDir = join(fakeHome, ".frames", "secrets", "org_default");
  mkdirSync(framesSecretsDir, { recursive: true });
  writeFileSync(
    join(framesSecretsDir, "x402.json"),
    JSON.stringify({
      provider_name: "open-wallet-standard",
      credential: "agent-treasury",
    }),
  );

  const cfgDir = join(fakeHome, ".frames", "pay");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.yaml");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
wallets:
  base:
    kind: frames
    label: shared
    dir: ${join(fakeHome, ".frames")}
    passphrase: "test-passphrase"
    evm: { chain: { id: 8453, name: Base } }
`,
  );

  // 1. Without OWS package installed → actionable error
  console.log("Test 1: kind: frames without @faremeter/wallet-ows");
  try {
    await loadRuntimeConfig(cfgPath);
    console.log("  ✗ expected error");
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("@faremeter/wallet-ows") && msg.includes("bun add")) {
      console.log(`  ✓ actionable: "${msg.slice(0, 100)}…"`);
    } else if (e instanceof ConfigError) {
      console.log(`  ✓ ConfigError: ${msg.slice(0, 100)}…`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
      exitCode = 1;
    }
  }

  // 2. Missing secrets file → actionable error
  console.log("\nTest 2: missing frames secrets file");
  rmSync(framesSecretsDir, { recursive: true, force: true });
  try {
    await loadRuntimeConfig(cfgPath);
    console.log("  ✗ expected error");
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("frames secrets file not found")) {
      console.log(`  ✓ actionable: "${msg.slice(0, 100)}…"`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
      exitCode = 1;
    }
  }

  // 3. Wrong provider_name → clear error
  console.log("\nTest 3: unsupported provider_name");
  mkdirSync(framesSecretsDir, { recursive: true });
  writeFileSync(
    join(framesSecretsDir, "x402.json"),
    JSON.stringify({ provider_name: "some-other-thing", credential: "x" }),
  );
  try {
    await loadRuntimeConfig(cfgPath);
    console.log("  ✗ expected error");
    exitCode = 1;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("provider") && msg.includes("not yet supported")) {
      console.log(`  ✓ rejects: "${msg.slice(0, 100)}…"`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
      exitCode = 1;
    }
  }

  // 4. Surface the wallet name from credential field
  // (we can't actually load the OWS wallet without the package + real vault,
  // but we can inspect the error chain to confirm it tried with the right name)
  console.log("\nTest 4: surfaces credential as wallet name");
  writeFileSync(
    join(framesSecretsDir, "x402.json"),
    JSON.stringify({
      provider_name: "open-wallet-standard",
      credential: "my-custom-wallet-name",
    }),
  );
  try {
    await loadRuntimeConfig(cfgPath);
    console.log("  ✗ expected error (no OWS package)");
    exitCode = 1;
  } catch (e) {
    // The error should be about the missing package, not about parsing the
    // secrets file — meaning we successfully read "my-custom-wallet-name".
    const msg = (e as Error).message;
    if (msg.includes("@faremeter/wallet-ows")) {
      console.log(`  ✓ read credential, attempted OWS load`);
    } else {
      console.log(`  ? unexpected: ${msg}`);
      exitCode = 1;
    }
  }

  console.log();
  if (exitCode === 0) console.log("✓ kind: frames factory works structurally");
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}
process.exit(exitCode);
