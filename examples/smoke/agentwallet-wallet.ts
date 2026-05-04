#!/usr/bin/env bun
// Smoke: pay's `kind: agentwallet` factory + delegated dispatch.
//
// Reads YOUR ~/.agentwallet/config.json, loads the apiToken+addresses,
// and verifies pay routes paid calls to frames.ag's /x402/fetch instead
// of faremeter.
//
// This smoke calls the test endpoint with a probe — by default a real
// $0.001 USDC settlement. Pass `--dry-run` flag to verify wiring without
// spending (calls /x402/fetch with dryRun: true if supported, otherwise
// stops before the actual call).

import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { loadRuntimeConfig } from "../../src/config.ts";
import { parseManifest } from "../../src/manifest/load.ts";
import { installManifest } from "../../src/manifest/install.ts";
import { saveLock, loadLock } from "../../src/manifest/lock.ts";
import { payForTool, DispatchError } from "../../src/wallet/dispatch.ts";

const acwPath = join(homedir(), ".agentwallet", "config.json");
if (!existsSync(acwPath)) {
  console.error(`No agentwallet config at ${acwPath}. Connect first via https://frames.ag.`);
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const dir = mkdtempSync(join(tmpdir(), "pay-aw-"));
let exitCode = 0;
try {
  const cfgDir = join(dir, ".frames", "pay");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.yaml");
  writeFileSync(
    cfgPath,
    `agent: claude:opus-4.7
catalog:
  default: https://catalog.microchipgnu.workers.dev
manifest_path: ./tools.yml
lock_path: ./tools.lock
wallets:
  base-sepolia:
    kind: agentwallet
    label: my-aw
`,
  );

  const cfg = await loadRuntimeConfig(cfgPath);
  const id = cfg.registry.walletId("base-sepolia");
  const addr = cfg.registry.addressFor("base-sepolia");
  console.log(`agentwallet entry loaded:`);
  console.log(`  wallet_id:      ${id}`);
  console.log(`  evm address:    ${addr}`);

  if (dryRun) {
    console.log(`\nDry-run mode — exiting before payForTool.`);
    console.log(`Run without --dry-run to perform a real $0.001 settle.`);
    process.exit(0);
  }

  // Install + call the test endpoint via agentwallet
  process.chdir(dir);
  const yamlText = `pay_protocol: 0.0.1
tools:
  test:
    url: https://catalog.microchipgnu.workers.dev/tools/frames.test.post.api-echo
`;
  writeFileSync("tools.yml", yamlText);
  const manifest = parseManifest(yamlText);
  console.log(`\nInstalling manifest...`);
  const lock = await installManifest(manifest);
  saveLock("tools.lock", lock);

  console.log(`Calling test endpoint via pay (delegating to agentwallet)...`);
  const t0 = Date.now();
  const result = await payForTool(
    {
      name: "test",
      params: { data: "agentwallet-pay-smoke" },
      manifest,
      lock: loadLock("tools.lock"),
    },
    { registry: cfg.registry, auditKey: cfg.auditKey },
  );
  const elapsed = Date.now() - t0;

  console.log(`\n  elapsed: ${elapsed}ms`);
  console.log(`  amount:  ${result.receipt.amount} ${result.receipt.currency}`);
  console.log(`  network: ${result.receipt.network}`);
  console.log(`  wallet:  ${result.receipt.wallet_id}  ${result.receipt.wallet_address}`);
  console.log(`  tx:      ${result.receipt.tx_hash ?? "(not returned)"}`);
  if (result.receipt.tx_hash) {
    console.log(`  view:    https://sepolia.basescan.org/tx/${result.receipt.tx_hash}`);
  }
  console.log(`  body:    ${JSON.stringify(result.body).slice(0, 200)}`);
  console.log();
  console.log("✓ pay -> agentwallet -> seller end-to-end works");
} catch (e) {
  if (e instanceof DispatchError) {
    console.error(`\n✗ DispatchError: ${e.message}`);
  } else {
    console.error(`\n✗ ${(e as Error).message}`);
  }
  exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
