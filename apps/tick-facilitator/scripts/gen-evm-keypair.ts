#!/usr/bin/env bun
//
// Generates an EVM (Base, Ethereum, Polygon, …) keypair. Output is the raw
// private key suitable for piping into a wrangler secret:
//
//   bun run scripts/gen-evm-keypair.ts | wrangler secret put EVM_FACILITATOR_PRIVATE_KEY
//
// Public address prints to stderr so you can `>` redirect stdout to a key
// file while still seeing the address.
//
// Uses viem (Faremeter's chosen EVM SDK) — same secp256k1 derivation +
// address computation that Faremeter does internally, so the address printed
// here matches what Faremeter will use when signing on this key.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function main() {
  const privateKey = generatePrivateKey(); // 0x + 64 hex chars
  const account = privateKeyToAccount(privateKey);

  // stderr: human-readable summary
  console.error("--- EVM keypair (secp256k1) ---");
  console.error(`address:           ${account.address}`);
  console.error(`compatible chains: Base, Ethereum, Polygon, Monad, Skale, any EVM`);
  console.error("");
  console.error("Store this hex string as EVM_FACILITATOR_PRIVATE_KEY:");
  console.error("");

  // stdout: just the private key, ready to pipe to wrangler secret put
  process.stdout.write(privateKey + "\n");
}

main();
