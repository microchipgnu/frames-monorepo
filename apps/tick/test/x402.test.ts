// Tests for the x402 v2 inbound verify + settle client (`src/payment/x402.ts`)
// and the PaymentRequirements builder. Real facilitator calls are mocked at
// the global fetch boundary so we can assert wire shape.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildPaymentRequirements, usdcToSmallestUnit } from "../src/payment/payment-requirements.ts";
import type { PaymentPayload, PaymentRequirements } from "../src/payment/types.ts";
import { decodePaymentPayload, settleX402, verifyInboundX402 } from "../src/payment/x402.ts";

// ---------------------------------------------------------------------------
// usdcToSmallestUnit + buildPaymentRequirements
// ---------------------------------------------------------------------------

describe("usdcToSmallestUnit()", () => {
  test("converts decimal USDC to 6-decimal smallest unit", () => {
    expect(usdcToSmallestUnit("1")).toBe("1000000");
    expect(usdcToSmallestUnit("0.15")).toBe("150000");
    expect(usdcToSmallestUnit("0.000001")).toBe("1");
    expect(usdcToSmallestUnit("100.5")).toBe("100500000");
  });

  test("rounds to nearest smallest unit", () => {
    expect(usdcToSmallestUnit("0.0000001")).toBe("0"); // sub-micro = 0
    expect(usdcToSmallestUnit("0.0000005")).toBe("1"); // rounds up
  });

  test("throws on invalid input", () => {
    expect(() => usdcToSmallestUnit("abc")).toThrow();
    expect(() => usdcToSmallestUnit("-1")).toThrow();
  });
});

describe("buildPaymentRequirements()", () => {
  test("returns null when TICK_PAY_TO_ADDRESS is unset", () => {
    expect(buildPaymentRequirements(undefined, "verify", "0.15")).toBeNull();
    expect(buildPaymentRequirements({} as any, "verify", "0.15")).toBeNull();
  });

  test("builds for Base default network", () => {
    const r = buildPaymentRequirements(
      { TICK_PAY_TO_ADDRESS: "0xabc" } as any,
      "verify",
      "0.15",
    );
    expect(r).not.toBeNull();
    expect(r!.payTo).toBe("0xabc");
    expect(r!.network).toBe("base");
    expect(r!.scheme).toBe("erc3009");
    expect(r!.amount).toBe("150000"); // 0.15 USDC in 6-decimal smallest unit
    expect(r!.asset).toMatch(/^0x[0-9a-fA-F]{40}$/); // USDC contract address
    expect(r!.maxTimeoutSeconds).toBe(90);
  });

  test("Solana network → spl-token scheme", () => {
    const r = buildPaymentRequirements(
      { TICK_PAY_TO_ADDRESS: "BPFLoader", TICK_PAY_NETWORK: "solana-mainnet" } as any,
      "verify",
      "0.15",
    );
    expect(r!.scheme).toBe("spl-token");
    expect(r!.network).toBe("solana-mainnet");
  });

  test("uses op default budget when caller passes none", () => {
    const r = buildPaymentRequirements(
      { TICK_PAY_TO_ADDRESS: "0xabc" } as any,
      "curate",
      undefined,
    );
    // DEFAULT_BUDGETS.curate is 3.00 → 3_000_000 smallest unit (bumped 2026-05-12)
    expect(r!.amount).toBe("3000000");
  });

  test("custom max timeout via env", () => {
    const r = buildPaymentRequirements(
      { TICK_PAY_TO_ADDRESS: "0xabc", TICK_PAY_MAX_TIMEOUT_SECONDS: "300" } as any,
      "verify",
      "0.15",
    );
    expect(r!.maxTimeoutSeconds).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// decodePaymentPayload
// ---------------------------------------------------------------------------

const SAMPLE_PAYLOAD: PaymentPayload = {
  x402Version: 2,
  resource: "/run",
  accepted: {
    scheme: "erc3009",
    network: "base",
    amount: "150000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xPayee",
    maxTimeoutSeconds: 90,
  },
  payload: { signature: "0xdeadbeef", from: "0xPayer", validAfter: 0, validBefore: 9999999999 },
};

function encodePaymentPayload(p: PaymentPayload): string {
  return btoa(JSON.stringify(p));
}

describe("decodePaymentPayload()", () => {
  test("round-trips standard base64", () => {
    const encoded = encodePaymentPayload(SAMPLE_PAYLOAD);
    const decoded = decodePaymentPayload(encoded);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.payTo).toBe("0xPayee");
    expect(decoded.payload.from).toBe("0xPayer");
  });

  test("accepts base64url-encoded payload", () => {
    const json = JSON.stringify(SAMPLE_PAYLOAD);
    const urlSafe = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decoded = decodePaymentPayload(urlSafe);
    expect(decoded.accepted.payTo).toBe("0xPayee");
  });

  test("throws on malformed base64", () => {
    expect(() => decodePaymentPayload("not-base64!!!*&%")).toThrow();
  });

  test("throws on valid base64 but invalid JSON", () => {
    expect(() => decodePaymentPayload(btoa("not json"))).toThrow();
  });

  test("throws when x402Version missing", () => {
    expect(() => decodePaymentPayload(btoa(JSON.stringify({ accepted: {}, payload: {} })))).toThrow();
  });

  test("throws when accepted PaymentRequirements missing", () => {
    expect(() => decodePaymentPayload(btoa(JSON.stringify({ x402Version: 2, payload: {} })))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyInboundX402 — wire shape via mocked fetch
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: unknown, status = 200) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k] ?? "";
    }
    fetchCalls.push({ url, body, headers });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

const SAMPLE_REQS: PaymentRequirements = SAMPLE_PAYLOAD.accepted;

describe("verifyInboundX402()", () => {
  test("optional mode + no header → ok with skipped=true", async () => {
    const req = new Request("https://tick.frames.ag/run", { method: "POST" });
    const r = await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, { optional: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  test("optional mode + no facilitator URL → ok with skipped=true", async () => {
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    const r = await verifyInboundX402(req, undefined, SAMPLE_REQS, { optional: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  test("strict mode + no header → ok:false", async () => {
    const req = new Request("https://tick.frames.ag/run", { method: "POST" });
    const r = await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, { optional: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("missing PAYMENT-SIGNATURE");
  });

  test("strict mode + no PaymentRequirements → ok:false", async () => {
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    const r = await verifyInboundX402(req, "https://facilitator.example", null, { optional: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("PaymentRequirements");
  });

  test("happy path → POST x402-v2 shape to /verify and parse isValid", async () => {
    mockFetch({ isValid: true, payer: "0xPayer" });
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    const r = await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, { optional: false });
    expect(r.ok).toBe(true);
    expect(r.payer).toBe("0xPayer");
    expect(r.paymentPayload).toBeDefined();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://facilitator.example/verify");
    expect(fetchCalls[0]!.body).toMatchObject({
      x402Version: 2,
      paymentRequirements: SAMPLE_REQS,
    });
    // Spec-shaped body, not custom shape:
    expect(fetchCalls[0]!.body).not.toHaveProperty("resource");
    expect(fetchCalls[0]!.body).not.toHaveProperty("body");
  });

  test("facilitator returns isValid:false → ok:false with invalidReason", async () => {
    mockFetch({ isValid: false, invalidReason: "signature expired" });
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    const r = await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, { optional: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("signature expired");
  });

  test("facilitator HTTP error → ok:false", async () => {
    mockFetch({ message: "facilitator down" }, 503);
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    const r = await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, { optional: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("503");
  });

  test("trailing slash on facilitator URL is normalized", async () => {
    mockFetch({ isValid: true, payer: "0xPayer" });
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    await verifyInboundX402(req, "https://facilitator.example/", SAMPLE_REQS, { optional: false });
    expect(fetchCalls[0]!.url).toBe("https://facilitator.example/verify");
  });

  test("malformed header → ok:false", async () => {
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": "not-base64-or-json" },
    });
    const r = await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, { optional: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("malformed PAYMENT-SIGNATURE");
  });

  test("custom facilitator auth headers are forwarded", async () => {
    mockFetch({ isValid: true, payer: "0xPayer" });
    const req = new Request("https://tick.frames.ag/run", {
      method: "POST",
      headers: { "payment-signature": encodePaymentPayload(SAMPLE_PAYLOAD) },
    });
    await verifyInboundX402(req, "https://facilitator.example", SAMPLE_REQS, {
      optional: false,
      facilitatorAuthHeader: { "x-cdp-api-key": "sekrit" },
    });
    expect(fetchCalls[0]!.headers["x-cdp-api-key"]).toBe("sekrit");
  });
});

// ---------------------------------------------------------------------------
// settleX402 — wire shape via mocked fetch
// ---------------------------------------------------------------------------

describe("settleX402()", () => {
  test("happy path → POST x402-v2 shape to /settle and parse transaction", async () => {
    mockFetch({
      success: true,
      payer: "0xPayer",
      transaction: "0xtxhash123",
      network: "base",
      amount: "150000",
    });
    const r = await settleX402("https://facilitator.example", SAMPLE_PAYLOAD, SAMPLE_REQS);
    expect(r.ok).toBe(true);
    expect(r.transaction).toBe("0xtxhash123");
    expect(r.network).toBe("base");
    expect(r.amount).toBe("150000");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://facilitator.example/settle");
    expect(fetchCalls[0]!.body).toMatchObject({
      x402Version: 2,
      paymentRequirements: SAMPLE_REQS,
    });
  });

  test("success:false → ok:false with errorReason", async () => {
    mockFetch({ success: false, errorReason: "on-chain revert", transaction: "", network: "base" });
    const r = await settleX402("https://facilitator.example", SAMPLE_PAYLOAD, SAMPLE_REQS);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("on-chain revert");
  });

  test("facilitator HTTP error → ok:false", async () => {
    mockFetch({ error: "boom" }, 502);
    const r = await settleX402("https://facilitator.example", SAMPLE_PAYLOAD, SAMPLE_REQS);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("502");
  });
});
