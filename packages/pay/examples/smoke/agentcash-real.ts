#!/usr/bin/env bun
// Real end-to-end with YOUR actual agentcash wallet.
//
//   1. Read pay config that points at ~/.agentcash/wallet.json
//   2. Resolve frames.test.post.api-echo (Base Sepolia, $0.001)
//   3. Pay through agentcash's wallet
//   4. Confirm signed receipt + on-chain tx
//
// Cost: 0.001 USDC from your agentcash Base wallet (if it has Sepolia funds —
// agentcash's primary network is Base mainnet, so this only succeeds if your
// agentcash wallet ALSO has Sepolia testnet USDC + ETH).

import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig } from "../../src/config.ts";
import { parseManifest } from "../../src/manifest/load.ts";
import { installManifest } from "../../src/manifest/install.ts";
import { saveLock, loadLock } from "../../src/manifest/lock.ts";
import { payForTool } from "../../src/wallet/dispatch.ts";

const acWalletPath = `${process.env.HOME}/.agentcash/wallet.json`;
if (!existsSync(acWalletPath)) {
  console.error(`No agentcash wallet at ${acWalletPath}`);
  console.error(`Run: npx agentcash@latest accounts`);
  process.exit(1);
}
const acAddr = JSON.parse(readFileSync(acWalletPath, "utf8")).address;
console.log(`Your agentcash EVM address: ${acAddr}`);

const dir = mkdtempSync(join(tmpdir(), "pay-acreal-"));
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
    kind: agentcash
    label: my-agentcash
    evm: { chain: { id: 84532, name: Base Sepolia } }
`,
  );

  const cfg = await loadRuntimeConfig(cfgPath);
  const loadedAddr = cfg.registry.addressFor("base-sepolia");
  console.log(`Pay loaded: ${loadedAddr}`);
  if (loadedAddr?.toLowerCase() !== acAddr.toLowerCase()) {
    console.error("✗ pay address doesn't match agentcash");
    process.exit(1);
  }
  console.log(`  ✓ matches`);

  // Manifest pointing at the test endpoint
  process.chdir(dir);
  const yamlText = `pay_protocol: 0.0.1
tools:
  test:
    url: https://catalog.microchipgnu.workers.dev/tools/frames.test.post.api-echo
`;
  writeFileSync("tools.yml", yamlText);
  const manifest = parseManifest(yamlText);
  console.log("\nInstalling manifest…");
  const lock = await installManifest(manifest);
  saveLock("tools.lock", lock);

  console.log("Calling test endpoint via pay (using agentcash wallet)…");
  const t0 = Date.now();
  const result = await payForTool(
    {
      name: "test",
      params: { data: "agentcash-pay-end-to-end" },
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
  console.log(`  tx:      ${result.receipt.tx_hash}`);
  if (!result.receipt.tx_hash || !result.receipt.tx_hash.startsWith("0x")) {
    console.log(`  ✗ no tx_hash`);
    exitCode = 1;
  } else {
    console.log(`  view:    https://sepolia.basescan.org/tx/${result.receipt.tx_hash}`);
  }
  console.log();
  if (exitCode === 0) console.log("✓ pay paid through your agentcash wallet end-to-end");
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
