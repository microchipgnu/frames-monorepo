#!/usr/bin/env bun
// Smoke test for @frames-ag/payment-tempo
//
// Two phases:
//   A. Structural — generate a fresh viem account, build the handler,
//      confirm it returns null for non-tempo challenges and an Execer
//      for tempo charge challenges. No network, no money.
//   B. End-to-end — point at a real Tempo MPP charge endpoint with a
//      funded Tempo mainnet wallet. Requires bridging USD onto Tempo
//      first (no public Devnet seller in our catalog yet).
//
// Run:  bun smoke

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeBase64URL } from "@faremeter/types/mpp";
import { createMPPTempoChargeClient } from "../src/charge/client.ts";
import type { mppChallengeParams } from "@faremeter/types/mpp";

console.log("== payment-tempo smoke ==\n");

// ----- Phase A: structural -----
console.log("Phase A: structural (no network)\n");

const account = privateKeyToAccount(generatePrivateKey());
console.log(`  generated viem account: ${account.address}`);

const handler = createMPPTempoChargeClient({ account });
console.log("  handler created\n");

// 1. Non-tempo challenge → null
const solanaChallenge: mppChallengeParams = {
  id: "test-id",
  realm: "test.example",
  method: "solana",
  intent: "charge",
  request: encodeBase64URL(
    JSON.stringify({ amount: "1000", currency: "usd", recipient: "abc" }),
  ),
};
const r1 = await handler(solanaChallenge);
console.log(`  non-tempo (method="solana") → ${r1 === null ? "✓ null" : "✗ not null"}`);

// 2. Tempo session → null (we only do charge)
const sessionChallenge: mppChallengeParams = {
  id: "test-id",
  realm: "test.example",
  method: "tempo",
  intent: "session",
  request: encodeBase64URL(JSON.stringify({})),
};
const r2 = await handler(sessionChallenge);
console.log(`  tempo session → ${r2 === null ? "✓ null" : "✗ not null"}`);

// 3. Tempo charge → Execer
const chargeChallenge: mppChallengeParams = {
  id: "test-id",
  realm: "test.example",
  method: "tempo",
  intent: "charge",
  request: encodeBase64URL(
    JSON.stringify({
      amount: "1000",
      currency: "0x20c000000000000000000000b9537d11c60e8b50", // USDC on Tempo
      recipient: account.address,
      decimals: 6,
    }),
  ),
};
const r3 = await handler(chargeChallenge);
console.log(`  tempo charge → ${r3 ? "✓ Execer returned" : "✗ null"}`);

// 4. Malformed request → null
const badChallenge: mppChallengeParams = {
  id: "test-id",
  realm: "test.example",
  method: "tempo",
  intent: "charge",
  request: "not-base64-json",
};
const r4 = await handler(badChallenge);
console.log(`  malformed request → ${r4 === null ? "✓ null" : "✗ not null"}`);

console.log("\n== Phase A complete ==\n");

// ----- Phase B: end-to-end (requires funded Tempo mainnet wallet) -----
console.log("Phase B: end-to-end\n");
console.log("  SKIPPED — requires Tempo mainnet USD funding.");
console.log("  To run end-to-end:");
console.log("    1. Provision a Tempo mainnet wallet with USD (Stripe-side flow)");
console.log("    2. Set TEMPO_PRIVATE_KEY env var");
console.log("    3. Pick an MPP-Tempo seller from the catalog (e.g. frames.firecrawl)");
console.log("    4. Wire @faremeter/fetch wrap with this handler in mppHandlers");
console.log("    5. Call the seller endpoint — fetch auto-pays via tempo.charge");
console.log();
console.log("  Tempo Devnet (chain 31318) end-to-end: requires a Devnet MPP seller,");
console.log("  none currently in our catalog. Track in PLAN.");
