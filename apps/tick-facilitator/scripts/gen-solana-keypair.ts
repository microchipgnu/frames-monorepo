#!/usr/bin/env bun
//
// Generates a Solana keypair in the canonical 64-byte JSON array format
// (same shape `solana-keygen new` produces). Output is suitable for piping
// directly into a wrangler secret:
//
//   bun run scripts/gen-solana-keypair.ts | wrangler secret put SOLANA_ADMIN_KEYPAIR_JSON
//
// Or to inspect/store locally:
//
//   bun run scripts/gen-solana-keypair.ts > admin-keypair.json
//   chmod 600 admin-keypair.json
//
// Public key (base58) prints to stderr so you can `>` redirect stdout to a
// keypair file while still seeing the address.
//
// Uses Node's built-in crypto module — no external deps required.

import { generateKeyPairSync, type KeyObject } from "node:crypto";

function main() {
  // ed25519 keypair via Node crypto. The "secret seed" is 32 bytes; the
  // canonical Solana format prepends it to the 32-byte public key for a
  // 64-byte array.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  const seed = extractEd25519Seed(privateKey); // 32 bytes
  const pub = extractEd25519PublicKey(publicKey); // 32 bytes

  const combined = new Uint8Array(64);
  combined.set(seed, 0);
  combined.set(pub, 32);

  const jsonArray = Array.from(combined);
  const address = toBase58(pub);

  // stderr: human-readable summary
  console.error("--- Solana keypair ---");
  console.error(`address (base58):  ${address}`);
  console.error(`length:            64 bytes (seed[0..32] | public[32..64])`);
  console.error("");
  console.error("Store this as SOLANA_ADMIN_KEYPAIR_JSON:");
  console.error("");

  // stdout: just the JSON array, ready to pipe
  process.stdout.write(JSON.stringify(jsonArray) + "\n");
}

/**
 * Extracts the raw 32-byte ed25519 seed from a Node KeyObject. The DER-
 * encoded private key includes a fixed 16-byte header before the seed.
 */
function extractEd25519Seed(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "pkcs8" });
  // PKCS8 wrapping for ed25519 is well-known; the seed is the last 32 bytes.
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Extracts the raw 32-byte ed25519 public key from a Node KeyObject. */
function extractEd25519PublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  // SPKI wrapping prefixes 12 bytes before the 32-byte raw key.
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Pure base58 encoder (Bitcoin alphabet) for the public key → address. */
function toBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  // Count leading zero bytes
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert big-endian bytes to a big-int–style base58 array
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += alphabet[digits[i]!];
  return out;
}

main();
