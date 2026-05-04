#!/usr/bin/env bun
// Smoke: pay's bridge handles `kind: tempo + protocol: mpp` via the lazy-loaded
// @frames-ag/payment-tempo package.
//
// Without the package installed → bridge returns a wrapped handler that throws
// an actionable error on first invocation (not at construction).
// With the package installed → handler delegates to mppx via the wrapper.

import { WalletRegistry } from "../../src/wallet/wallet-registry.ts";
import { buildHandlers, BridgeError } from "../../src/wallet/faremeter-bridge.ts";
import type { ToolDescriptor } from "../../src/types.ts";

let exitCode = 0;
function assert(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) exitCode = 1;
}

const descriptor: ToolDescriptor = {
  pay_protocol: "0.0.1",
  id: "test.tempo",
  title: "Tempo MPP test",
  description: "test",
  capabilities: ["test"],
  invocation: { method: "POST", url: "https://example.test" },
  payment: {
    protocol: "mpp",
    network: "tempo",
    currency: "USDC",
    price_hint: "0.001",
  },
};

// Mock viem account for the registry entry. The bridge constructs the
// handler lazily — this won't actually try to use the account unless we
// invoke the handler.
const mockTempoEntry = {
  kind: "tempo" as const,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: { address: "0x0000000000000000000000000000000000000001" } as any,
  label: "smoke",
  address: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  source: "tempo" as const,
};

const registry = new WalletRegistry({
  byNetwork: { tempo: mockTempoEntry },
  agent: "smoke:tempo",
});

console.log("Bridge construction (Tempo MPP):");
const r = buildHandlers(descriptor, registry);
assert("returns 1 mppHandler", r.mppHandlers.length === 1);
assert("standard handlers empty", r.handlers.length === 0);
assert("not free", r.free === false);
assert("walletEntry kind=tempo", r.walletEntry?.kind === "tempo");

console.log("\nFirst invocation (lazy import):");
// Construct a fake mppChallengeParams to invoke the handler. Whether the
// package is installed or not determines what happens next.
const fakeChallenge = {
  id: "test-id",
  realm: "test.example",
  method: "tempo" as const,
  intent: "charge" as const,
  // base64url of `{}` — minimal valid request body
  request: "e30",
};

let outcome: "executor" | "package-missing" | "other-error" = "other-error";
let outcomeDetail = "";
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await r.mppHandlers[0]!(fakeChallenge as any);
  if (result === null) {
    outcome = "executor";
    outcomeDetail = "handler returned null (would mean challenge mismatch)";
  } else {
    outcome = "executor";
    outcomeDetail = "handler returned a PaymentExecer (package is installed)";
  }
} catch (e) {
  const msg = (e as Error).message;
  if (e instanceof BridgeError && msg.includes("@frames-ag/payment-tempo")) {
    outcome = "package-missing";
    outcomeDetail = msg;
  } else {
    outcome = "other-error";
    outcomeDetail = msg;
  }
}

if (outcome === "executor") {
  console.log(`  ✓ package installed → handler returned`);
  console.log(`    ${outcomeDetail}`);
} else if (outcome === "package-missing") {
  console.log(`  ✓ package NOT installed → actionable error thrown`);
  console.log(`    ${outcomeDetail}`);
} else {
  console.log(`  ? unexpected: ${outcomeDetail}`);
  exitCode = 1;
}

console.log();
if (exitCode === 0) console.log("✓ Tempo MPP bridge wiring works");
process.exit(exitCode);
