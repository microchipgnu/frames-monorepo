// Smoke: verify receipt persistence (Gap 1 fix).
//
// Two paths exercised:
//   (a) Frame-detected: cwd = a temp dir containing schema.yml + events.ndjson
//       → tool.invoked event appended to that dataset's events.ndjson.
//   (b) No frame context: temp HOME, no PAY_FRAME_DATASET, no schema.yml in cwd
//       → tool.invoked event appended to <HOME>/.frames/pay/events.ndjson.
//
// Run: bun run smoke:persistence

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  FilesystemStore,
  defaultFallbackPath,
} from "../../src/stores/filesystem.ts";
import {
  detectFrameDataset,
  appendToolInvokedEvent,
} from "../../src/frame/event.ts";
import type { Receipt } from "../../src/types.ts";

function fakeReceipt(): Receipt {
  return {
    pay_protocol: "0.0.1",
    id: `01HK${randomUUID().slice(0, 8).toUpperCase()}`,
    ts: new Date().toISOString(),
    tool_id: "frames.test.post.api-echo",
    tool_local_name: "test",
    descriptor_id: "sha256-fakedescriptorforpersistencesmoke",
    params_hash: "sha256-fakeparamshash",
    protocol: "x402v2",
    wallet_id: "evm:smoke",
    wallet_address: "0x0000000000000000000000000000000000000001",
    amount: "0.001",
    currency: "USDC",
    network: "base-sepolia",
    agent: "claude:opus-4.7",
    signature: "ed25519:fakesignatureforsmoke",
  };
}

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

async function main() {
  const tmpRoot = resolve(tmpdir(), `pay-persistence-smoke-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });

  // ---- (a) Frame-detected via PAY_FRAME_DATASET ----
  console.log("\n(a) frame-detected via PAY_FRAME_DATASET");
  const ds1 = resolve(tmpRoot, "ds-explicit");
  mkdirSync(ds1);
  writeFileSync(resolve(ds1, "schema.yml"), "name: test-ds\n");
  writeFileSync(resolve(ds1, "events.ndjson"), "");
  process.env["PAY_FRAME_DATASET"] = ds1;
  const detected1 = detectFrameDataset();
  assert(detected1 === ds1, `detectFrameDataset returns env-set path (got ${detected1})`);
  await appendToolInvokedEvent(ds1, fakeReceipt());
  const content1 = readFileSync(resolve(ds1, "events.ndjson"), "utf8");
  const event1 = JSON.parse(content1.trim().split("\n").at(-1)!);
  assert(event1.type === "tool.invoked", `event.type === "tool.invoked"`);
  assert(event1.payload?.receipt?.tool_id === "frames.test.post.api-echo", `receipt inlined`);
  assert(event1.payload?.receipt?.signature === "ed25519:fakesignatureforsmoke", `signature inlined`);
  delete process.env["PAY_FRAME_DATASET"];

  // ---- (b) Frame-detected via cwd heuristic ----
  console.log("\n(b) frame-detected via cwd heuristic");
  const ds2 = resolve(tmpRoot, "ds-cwd");
  mkdirSync(ds2);
  writeFileSync(resolve(ds2, "schema.yml"), "name: test-ds-2\n");
  writeFileSync(resolve(ds2, "events.ndjson"), "");
  const detected2 = detectFrameDataset(ds2);
  assert(detected2 === ds2, `detectFrameDataset(cwd) returns cwd when schema.yml + events.ndjson present`);

  // Negative: cwd with neither file
  const noDs = resolve(tmpRoot, "no-ds");
  mkdirSync(noDs);
  const detected3 = detectFrameDataset(noDs);
  assert(detected3 === null, `detectFrameDataset returns null in non-dataset cwd`);

  // ---- (c) FilesystemStore appends ----
  console.log("\n(c) FilesystemStore append");
  const fallback = resolve(tmpRoot, "fallback", "events.ndjson");
  const store = new FilesystemStore(fallback);
  await store.append(fakeReceipt());
  await store.append(fakeReceipt());
  assert(existsSync(fallback), `fallback file created`);
  const lines = readFileSync(fallback, "utf8").trim().split("\n");
  assert(lines.length === 2, `two events appended (got ${lines.length})`);
  const e1 = JSON.parse(lines[0]!);
  assert(e1.type === "tool.invoked", `each line is a tool.invoked event`);

  // ---- (d) defaultFallbackPath honors HOME ----
  console.log("\n(d) defaultFallbackPath uses $HOME");
  process.env["HOME"] = tmpRoot;
  const fp = defaultFallbackPath();
  assert(
    fp === resolve(tmpRoot, ".frames", "pay", "events.ndjson"),
    `default fallback path is $HOME/.frames/pay/events.ndjson (got ${fp})`,
  );

  // ---- (e) Refuses to create events.ndjson if absent ----
  console.log("\n(e) appendToolInvokedEvent refuses to bootstrap");
  const ghost = resolve(tmpRoot, "ghost-ds");
  mkdirSync(ghost);
  writeFileSync(resolve(ghost, "schema.yml"), "name: ghost\n");
  // No events.ndjson — should refuse
  let threw = false;
  try {
    await appendToolInvokedEvent(ghost, fakeReceipt());
  } catch {
    threw = true;
  }
  assert(threw, `appendToolInvokedEvent refuses when events.ndjson is absent`);

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
  console.log("\n✓ Gap 1 — receipt persistence works end-to-end");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
