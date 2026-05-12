// Tests for the audit-signer module. These cover the load-bearing primitives:
//   - canonical() JSON serialization (must match what offline verifiers
//     reconstruct to recompute the signature digest)
//   - signReceipt() seed parsing (hex AND base64url) + PKCS8 wrapping for WebCrypto
//   - graceful "no key configured" behavior

import { describe, expect, test } from "bun:test";
import { canonical, getAuditSigner, signReceipt } from "../src/payment/audit-signer.ts";

// A real 32-byte ed25519 seed. The audit-signer module caches the first
// successfully-loaded key per-isolate, so tests using this seed share one
// signing key — that's what production looks like too.
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

const SAMPLE_RECEIPT = {
  pay_protocol: "0.0.1",
  id: "rec_abc",
  ts: "2026-05-11T00:00:00Z",
  tool_id: "tool.example",
  descriptor_id: "desc_xyz",
  params_hash: "sha256-deadbeef",
  protocol: "x402",
  wallet_id: "tick",
  wallet_address: "(self-custody)",
  amount: "0.001",
  currency: "USDC",
  network: "base",
  agent: "frames-runtime:test",
};

// ---------------------------------------------------------------------------
// canonical()
// ---------------------------------------------------------------------------

describe("canonical()", () => {
  test("sorts object keys deterministically", () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical({ z: 1, a: 1, m: 1 })).toBe('{"a":1,"m":1,"z":1}');
  });

  test("recurses into nested objects", () => {
    expect(canonical({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  test("preserves array order", () => {
    expect(canonical([3, 1, 2])).toBe("[3,1,2]");
    expect(canonical({ x: [{ b: 1, a: 2 }, { d: 3, c: 4 }] })).toBe('{"x":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  test("encodes primitives like JSON.stringify", () => {
    expect(canonical("hello")).toBe('"hello"');
    expect(canonical(42)).toBe("42");
    expect(canonical(true)).toBe("true");
    expect(canonical(false)).toBe("false");
    expect(canonical(null)).toBe("null");
    expect(canonical(undefined)).toBe("null");
  });

  test("escapes quotes in strings", () => {
    expect(canonical({ a: 'has "quotes"' })).toBe('{"a":"has \\"quotes\\""}');
  });

  test("two equivalent objects produce identical canonical form", () => {
    const a = canonical({ x: 1, y: { b: 2, a: 3 } });
    const b = canonical({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// signReceipt() — these run BEFORE any successful key load so the module-level
// cache stays empty. getAuditSigner caches the first successfully-loaded key
// per-isolate, which is the correct production behavior but makes order
// matter in tests.
// ---------------------------------------------------------------------------

describe("signReceipt() — no-key paths (run first)", () => {
  test("returns empty string when env has no AUDIT_PRIVATE_KEY", async () => {
    const sig = await signReceipt(SAMPLE_RECEIPT, {});
    expect(sig).toBe("");
  });

  test("returns empty string when key is malformed (not hex, not base64url)", async () => {
    // 31 chars — fails the /^[0-9a-fA-F]{64}$/ regex and the base64url
    // try/atob can't make 32 bytes from it, so parseSeed returns null.
    const sig = await signReceipt(SAMPLE_RECEIPT, { AUDIT_PRIVATE_KEY: "not-a-real-seed" });
    expect(sig).toBe("");
  });

  test("getAuditSigner returns null when env has no key", async () => {
    const key = await getAuditSigner({});
    expect(key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// signReceipt() — key-loaded paths. These tests share the cached key from
// the first successful load (per-isolate cache, matches production).
// ---------------------------------------------------------------------------

describe("signReceipt() — with key loaded", () => {
  test("signs receipts and returns base64url output", async () => {
    const sig = await signReceipt(SAMPLE_RECEIPT, { AUDIT_PRIVATE_KEY: SEED_HEX });
    expect(sig.length).toBeGreaterThan(0);
    // base64url alphabet only: A-Z, a-z, 0-9, -, _
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    // ed25519 sigs are 64 bytes → 86 chars of base64url (no padding).
    expect(sig.length).toBe(86);
  });

  test("same receipt → identical signature (deterministic)", async () => {
    const sig1 = await signReceipt(SAMPLE_RECEIPT, { AUDIT_PRIVATE_KEY: SEED_HEX });
    const sig2 = await signReceipt(SAMPLE_RECEIPT, { AUDIT_PRIVATE_KEY: SEED_HEX });
    expect(sig1).toBe(sig2);
  });

  test("signature changes when receipt content changes", async () => {
    const sigA = await signReceipt({ ...SAMPLE_RECEIPT, amount: "0.001" }, { AUDIT_PRIVATE_KEY: SEED_HEX });
    const sigB = await signReceipt({ ...SAMPLE_RECEIPT, amount: "0.002" }, { AUDIT_PRIVATE_KEY: SEED_HEX });
    expect(sigA).not.toBe(sigB);
    expect(sigA.length).toBe(86);
    expect(sigB.length).toBe(86);
  });

  test("signature is stable across key-order permutations of the receipt", async () => {
    // Canonical JSON sorts keys, so { a, b } and { b, a } must produce the
    // same signature — this is the cornerstone of offline verifiability.
    const sigA = await signReceipt(
      { tool_id: "t", amount: "0.001", id: "r" },
      { AUDIT_PRIVATE_KEY: SEED_HEX },
    );
    const sigB = await signReceipt(
      { id: "r", amount: "0.001", tool_id: "t" },
      { AUDIT_PRIVATE_KEY: SEED_HEX },
    );
    expect(sigA).toBe(sigB);
  });

  test("existing signature field is excluded from the signed bytes", async () => {
    // Two receipts that differ only in the (placeholder) signature field
    // should produce the same digest, because signReceipt strips it before
    // canonicalizing.
    const sigA = await signReceipt({ ...SAMPLE_RECEIPT, signature: "" }, { AUDIT_PRIVATE_KEY: SEED_HEX });
    const sigB = await signReceipt(
      { ...SAMPLE_RECEIPT, signature: "old-junk-from-elsewhere" },
      { AUDIT_PRIVATE_KEY: SEED_HEX },
    );
    expect(sigA).toBe(sigB);
  });
});
