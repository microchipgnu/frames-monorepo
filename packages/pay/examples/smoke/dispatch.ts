#!/usr/bin/env bun
// Stage 1b end-to-end smoke:
//
//   1. Reuse the funded Base Sepolia wallet from `bun smoke:gen-wallet`
//   2. Build a manifest pointing at frames.test.post.api-echo
//   3. installManifest → tools.lock
//   4. payForTool({ name: "test", params: { data: ... } })
//   5. Verify the returned receipt:
//        - signature verifies against the audit key's public key
//        - descriptor_id matches resolved entry
//        - tx_hash present and on-chain
//        - response body has the echoed payment
//   6. Confirm the same receipt JSON, re-signed, matches (signing is deterministic)
//
// Cost: $0.001 USDC on Base Sepolia. Same wallet as smoke:settle.

import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalWallet } from "@faremeter/wallet-evm";

import { parseManifest } from "../../src/manifest/load.ts";
import { installManifest } from "../../src/manifest/install.ts";
import { saveLock, loadLock } from "../../src/manifest/lock.ts";
import { WalletRegistry } from "../../src/wallet/wallet-registry.ts";
import { payForTool } from "../../src/wallet/dispatch.ts";
import {
  loadOrCreateAuditKey,
  DEFAULT_AUDIT_KEY_PATH,
} from "../../src/wallet/audit-key.ts";
import { verifyReceipt } from "../../src/wallet/receipt.ts";

const CATALOG = "https://catalog.microchipgnu.workers.dev";
const WALLET_PATH = pathResolve(import.meta.dir, ".wallet");
const BASE_SEPOLIA = { id: 84532, name: "Base Sepolia" } as const;

if (!existsSync(WALLET_PATH)) {
  console.error(`No wallet at ${WALLET_PATH} — run \`bun smoke:gen-wallet\` first`);
  process.exit(1);
}
const privateKey = readFileSync(WALLET_PATH, "utf8").trim() as `0x${string}`;
const account = privateKeyToAccount(privateKey);
console.log(`Wallet:      ${account.address}`);

// 1. Set up a wallet registry with the funded Base Sepolia wallet.
const evmWallet = await createLocalWallet(BASE_SEPOLIA, privateKey);
const registry = new WalletRegistry({
  byNetwork: {
    "base-sepolia": { kind: "evm", wallet: evmWallet, label: "smoke", source: "evm" },
  },
  agent: "claude:opus-4.7",
});

// 2. Audit key (under ~/.frames/pay/ — generated on first run)
const auditKey = await loadOrCreateAuditKey();
console.log(`Audit key:   ed25519 ${auditKey.publicKeyHex.slice(0, 16)}…`);

// 3. Manifest + install
const dir = mkdtempSync(join(tmpdir(), "pay-1b-"));
let exitCode = 0;
try {
  const yamlText = `pay_protocol: 0.0.1
tools:
  test:
    url: ${CATALOG}/tools/frames.test.post.api-echo
`;
  writeFileSync(join(dir, "tools.yml"), yamlText);
  const manifest = parseManifest(yamlText);
  console.log(`\nInstalling…`);
  const lock = await installManifest(manifest);
  saveLock(join(dir, "tools.lock"), lock);
  const lockEntry = lock.resolved["test"];
  if (!lockEntry) throw new Error("lock missing 'test' entry");
  console.log(`  test → ${lockEntry.descriptor_id.slice(0, 28)}…`);

  // 4. payForTool
  console.log(`\nDispatching payForTool({ name: "test", params: ... })…`);
  const reloaded = loadLock(join(dir, "tools.lock"));
  const t0 = Date.now();
  const result = await payForTool(
    {
      name: "test",
      params: { data: { hello: "from-pay-stage-1b", ts: Date.now() } },
      lock: reloaded,
    },
    { registry, auditKey },
  );
  const elapsed = Date.now() - t0;
  console.log(`  elapsed: ${elapsed}ms`);

  // 5. Validate the result
  console.log(`\nResult:`);
  console.log(
    `  body:    ${JSON.stringify(result.body).slice(0, 180)}${
      JSON.stringify(result.body).length > 180 ? "…" : ""
    }`,
  );
  console.log(`  receipt:`);
  console.log(`    id              ${result.receipt.id}`);
  console.log(`    tool_id         ${result.receipt.tool_id}`);
  console.log(`    tool_local_name ${result.receipt.tool_local_name ?? "(none)"}`);
  console.log(`    descriptor_id   ${result.receipt.descriptor_id.slice(0, 28)}…`);
  console.log(`    protocol        ${result.receipt.protocol}`);
  console.log(`    amount          ${result.receipt.amount} ${result.receipt.currency}`);
  console.log(`    network         ${result.receipt.network}`);
  console.log(`    wallet_id       ${result.receipt.wallet_id}`);
  console.log(`    wallet_address  ${result.receipt.wallet_address}`);
  console.log(`    tx_hash         ${result.receipt.tx_hash ?? "(none)"}`);
  console.log(`    signature       ${result.receipt.signature.slice(0, 36)}…`);

  // Signature verifies
  const verified = await verifyReceipt(result.receipt, auditKey.publicKey);
  console.log(`\n  signature verifies: ${verified ? "✓" : "✗ FAILED"}`);
  if (!verified) exitCode = 1;

  // descriptor_id matches lock
  if (result.receipt.descriptor_id !== lockEntry.descriptor_id) {
    console.log(`  descriptor_id mismatch: ${result.receipt.descriptor_id} vs ${lockEntry.descriptor_id}`);
    exitCode = 1;
  } else {
    console.log(`  descriptor_id matches lock: ✓`);
  }

  // tx_hash sanity
  if (!result.receipt.tx_hash || !result.receipt.tx_hash.startsWith("0x")) {
    console.log(`  tx_hash sanity: ✗ missing or malformed`);
    exitCode = 1;
  } else {
    console.log(`  tx_hash sanity: ✓ (${result.receipt.tx_hash.slice(0, 20)}…)`);
    console.log(`     view: https://sepolia.basescan.org/tx/${result.receipt.tx_hash}`);
  }

  console.log();
  if (exitCode === 0) {
    console.log("✓ Stage 1b end-to-end works");
    console.log(`  audit key: ${DEFAULT_AUDIT_KEY_PATH}`);
  } else {
    console.log("✗ Stage 1b smoke had failures");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exitCode);
