// Audit-key signer for ToolInvokedReceipts.
//
// Per pay/SPEC.md, every receipt carries an ed25519 signature over the
// canonical JSON of its fields. Offline verifiers (frame readers, anyone
// inspecting events.ndjson) can confirm the receipt came from tick.
//
// Bootstrap:
//   - AUDIT_PRIVATE_KEY env var (32-byte ed25519 seed, hex or base64url)
//   - If missing at boot, signing is skipped and receipts carry signature: ""
//   - /health surfaces audit_key_configured so operators can confirm

import { log } from "../util/log";

let cachedKey: CryptoKey | null = null;
let publicKey: CryptoKey | null = null;

/**
 * Lazy-load the operator audit signing key from env. Cached across requests
 * within the same Worker isolate.
 *
 * Accepts either 32-byte hex (64 chars) or 32-byte base64url. PKCS8 wrapping
 * is added before importKey since WebCrypto doesn't accept raw ed25519 seeds.
 */
async function loadKey(rawKey: string): Promise<CryptoKey | null> {
  try {
    const seed = parseSeed(rawKey);
    if (!seed) return null;
    // WebCrypto requires PKCS8-wrapped ed25519. The wrapping is a fixed prefix
    // (16 bytes) + the 32-byte seed.
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0);
    pkcs8.set(seed, 16);
    return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  } catch (e) {
    log.error("audit_key_load_failed", { error: (e as Error).message });
    return null;
  }
}

function parseSeed(s: string): Uint8Array | null {
  s = s.trim();
  // Hex
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // Base64url
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    const decoded = atob(b64);
    if (decoded.length !== 32) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = decoded.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function getAuditSigner(env: { AUDIT_PRIVATE_KEY?: string }): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey;
  if (!env.AUDIT_PRIVATE_KEY) return null;
  cachedKey = await loadKey(env.AUDIT_PRIVATE_KEY);
  return cachedKey;
}

/**
 * Sign the canonical JSON of `receipt` and return base64url(signature).
 *
 * Canonical-JSON here is "keys sorted recursively, no whitespace" — not
 * full JCS (RFC 8785), but sufficient for our internal signing/verification
 * loop. Anyone verifying offline uses the same `canonical()` function.
 */
export async function signReceipt(
  receipt: Record<string, unknown>,
  env: { AUDIT_PRIVATE_KEY?: string },
): Promise<string> {
  const key = await getAuditSigner(env);
  if (!key) return "";
  // Strip the signature field if present — we sign over everything else.
  const { signature: _drop, ...rest } = receipt as { signature?: unknown };
  void _drop;
  const message = new TextEncoder().encode(canonical(rest));
  const sig = await crypto.subtle.sign("Ed25519", key, message);
  return base64url(new Uint8Array(sig));
}

/**
 * Canonical JSON: recursively sort object keys, no whitespace. Matches
 * what an offline verifier reconstructs from the receipt to recompute the
 * signature digest.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
