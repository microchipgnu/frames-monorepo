#!/usr/bin/env bun
// Smoke test, phase B: real x402 settle on Base Sepolia.
// Uses faremeter (no pay library yet) to call frames.test.post.api-echo
// which costs $0.001 USDC on Base Sepolia.
//
// Prereqs:
//   bun smoke:gen-wallet   # creates examples/smoke/.wallet
//   fund the address with ETH (gas) and USDC (payment) on Base Sepolia
//
// What this proves:
//   - faremeter wallet can sign EIP-3009 USDC transfer authorization
//   - the seller accepts the signed payment
//   - we get a 200 response with the actual call result
//   - if all of the above works, pay's library is just packaging

import { wrap } from "@faremeter/fetch";
import { createPaymentHandler } from "@faremeter/payment-evm/exact";
import { createLocalWallet } from "@faremeter/wallet-evm";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_PATH = resolve(__dirname, ".wallet");
const CATALOG = "https://catalog.microchipgnu.workers.dev";
const TOOL_ID = "frames.test.post.api-echo";

if (!existsSync(WALLET_PATH)) {
  console.error("No wallet at examples/smoke/.wallet — run `bun smoke:gen-wallet` first");
  process.exit(1);
}
const privateKey = readFileSync(WALLET_PATH, "utf8").trim() as `0x${string}`;

// Base Sepolia chain config (faremeter's ChainInfo shape)
const BASE_SEPOLIA = {
  id: 84532,
  name: "Base Sepolia",
} as const;

console.log(`Catalog: ${CATALOG}`);
console.log(`Tool:    ${TOOL_ID}`);

// Step 1: fetch descriptor
console.log("\n→ fetching descriptor from catalog…");
const descRes = await fetch(`${CATALOG}/tools/${TOOL_ID}`);
if (!descRes.ok) throw new Error(`catalog ${descRes.status}`);
const descriptor = await descRes.json() as {
  invocation: { method: string; url: string };
  payment: { network: string; price_hint: string };
};
console.log(`  url:     ${descriptor.invocation.url}`);
console.log(`  network: ${descriptor.payment.network}`);
console.log(`  price:   $${descriptor.payment.price_hint}`);

// Step 2: build wallet
console.log("\n→ creating faremeter EVM wallet on Base Sepolia…");
const wallet = await createLocalWallet(BASE_SEPOLIA, privateKey);
console.log(`  address: ${wallet.address}`);

// Step 3: build payment handler
console.log("\n→ creating x402 payment handler…");
const handler = createPaymentHandler(wallet);

// Step 4: wrap fetch with payment auto-handling
const payFetch = wrap(fetch, { handlers: [handler] });

// Step 5: call the endpoint
console.log("\n→ calling endpoint with auto-payment…");
const t0 = Date.now();
const res = await payFetch(descriptor.invocation.url, {
  method: descriptor.invocation.method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: { hello: "from-pay-smoke", ts: Date.now() } }),
});
const elapsed = Date.now() - t0;

console.log(`  status:  ${res.status} ${res.statusText}`);
console.log(`  elapsed: ${elapsed}ms`);

const text = await res.text();
console.log(`  body:    ${text.slice(0, 400)}`);

if (res.status === 200) {
  console.log("\n✓ SUCCESS — pay's foundation works end-to-end");
  console.log("  catalog → faremeter → 402 → sign → settle → 200");
  console.log("  Next: build pay library + MCP on top of this exact wire path.");
} else {
  console.log("\n✗ Failed — inspect the body above to diagnose");
  process.exit(1);
}
