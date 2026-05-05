// Per-machine Ed25519 audit key for signing receipts.
// Generated on first use; stored at ~/.frames/pay/audit-key.json with mode 0600.
//
// Closes pre-mortem T3 ("Ed25519 audit key has no provisioning story").

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AuditKeyPair {
  publicKey: Uint8Array;
  privateKey: CryptoKey; // non-extractable when from generateKey
  publicKeyHex: string;
}

export interface SerializedAuditKey {
  /** "ed25519" — version/algorithm marker */
  alg: "ed25519";
  /** base64url, raw 32 bytes */
  publicKey: string;
  /** base64, PKCS#8 — preserves the private key's format */
  privateKey: string;
}

export const DEFAULT_AUDIT_KEY_PATH = resolve(
  homedir(),
  ".frames",
  "pay",
  "audit-key.json",
);

/**
 * Load the audit key from disk, or generate + persist a fresh one.
 * On generation prints a recovery hint pointing at the file path.
 */
export async function loadOrCreateAuditKey(
  filePath: string = DEFAULT_AUDIT_KEY_PATH,
): Promise<AuditKeyPair> {
  if (existsSync(filePath)) {
    return await loadAuditKey(filePath);
  }
  return await createAndPersistAuditKey(filePath);
}

async function loadAuditKey(filePath: string): Promise<AuditKeyPair> {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as SerializedAuditKey;
  if (raw.alg !== "ed25519") {
    throw new Error(`unsupported audit key alg: ${raw.alg}`);
  }
  const publicKey = base64urlDecode(raw.publicKey);
  const privateKeyBytes = base64Decode(raw.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes as BufferSource,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  return {
    publicKey,
    privateKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}

async function createAndPersistAuditKey(filePath: string): Promise<AuditKeyPair> {
  mkdirSync(dirname(filePath), { recursive: true });
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const publicSpki = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privatePkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const publicKey = new Uint8Array(publicSpki);

  const serialized: SerializedAuditKey = {
    alg: "ed25519",
    publicKey: base64urlEncode(publicKey),
    privateKey: base64Encode(new Uint8Array(privatePkcs8)),
  };
  writeFileSync(filePath, JSON.stringify(serialized, null, 2) + "\n");
  chmodSync(filePath, 0o600);

  console.error(
    `[pay] generated new audit key at ${filePath} — back this up; ` +
      `losing it means future receipts can't be cryptographically tied to past ones`,
  );
  return {
    publicKey,
    privateKey: pair.privateKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}

// ---- encoding helpers ----

function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export { base64urlEncode, base64urlDecode };
