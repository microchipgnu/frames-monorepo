// classifyPayError tests — pins the kind/retryable/details surface that
// pay_tool surfaces through the MCP boundary.
//
// Motivated by 2026-05-26 layoffs-2026 discover run where the aggregated
// "no rail succeeded across N payment options" message fell through to
// `kind: "unknown"` because classifyPayError didn't recognize the PR #17
// prefix. Programs branching on `kind` couldn't tell agentwallet outages
// from real wallet issues.

import { describe, expect, test } from "bun:test";
import { classifyPayError } from "../src/errors.ts";
import { DispatchError } from "../src/wallet/dispatch.ts";

describe("classifyPayError", () => {
  test("aggregated 'no rail succeeded' with uniform 429 classifies as retryable agentwallet_unreachable", () => {
    const msg =
      `no rail succeeded across 5 payment options: ` +
      `[x402v2/base via agentwallet:test] selected; ` +
      `[x402v2/base via agentwallet:test] selected; ` +
      `|| runtime failures: ` +
      `[option 0 x402v2/base/USDC] agentwallet 429: {"error":"Too many requests"}; ` +
      `[option 1 x402v2/base/USDT] agentwallet 429: {"error":"Too many requests"}`;
    const err = new DispatchError(msg);
    const classified = classifyPayError(err);
    expect(classified.kind).toBe("agentwallet_unreachable");
    expect(classified.retryable).toBe(true);
    expect(classified.details?.rail_count).toBe(2);
    expect(classified.details?.uniform_status).toBe(429);
  });

  test("aggregated with uniform 500 classifies as retryable agentwallet_unreachable", () => {
    const msg =
      `no rail succeeded across 3 payment options: ... || runtime failures: ` +
      `[option 0 x402v2/base/USDC] agentwallet 500: {"error":"INTERNAL"}; ` +
      `[option 1 x402v2/solana-mainnet/USDC] agentwallet 500: {"error":"INTERNAL"}; ` +
      `[option 2 x402v2/solana-mainnet/CASH] agentwallet 500: {"error":"INTERNAL"}`;
    const classified = classifyPayError(new DispatchError(msg));
    expect(classified.kind).toBe("agentwallet_unreachable");
    expect(classified.retryable).toBe(true);
    expect(classified.details?.rail_count).toBe(3);
    expect(classified.details?.uniform_status).toBe(500);
  });

  test("single agentwallet 429 with body surfaces body in details", () => {
    const err = new DispatchError(
      `agentwallet 429: {"error":"Too many requests"}`,
      {
        parsed: { error: "Too many requests" },
        raw: `{"error":"Too many requests"}`,
        status: 429,
        source: "agentwallet",
      },
    );
    const classified = classifyPayError(err);
    expect(classified.kind).toBe("agentwallet_unreachable");
    // 429 is retryable (rate-limit lifts).
    expect(classified.retryable).toBe(true);
    expect(classified.details?.agentwallet_status).toBe(429);
    expect(classified.details?.body).toEqual({ error: "Too many requests" });
    expect(classified.details?.body_source).toBe("agentwallet");
  });

  test("agentwallet 500 with body — caller sees full parsed body, not truncated prefix", () => {
    // The actual bug from 2026-05-26: the response body that explains WHY
    // agentwallet 500'd extended past the old 200-char truncation cliff.
    const realBody = {
      success: false,
      paid: false,
      attempts: 1,
      duration: 533,
      payment: {
        chain: "eip155:8453",
        amountRaw: "10000",
        amountFormatted: "0.01 USDC",
        recipient: "0xe62923133a417cEe4241677865Ed5a63F44F4B54",
        // …the real reason was past this point and got truncated:
        tx_error: "EIP-3009 signature verification failed: nonce already used",
        nonce: "0x" + "ab".repeat(32),
      },
    };
    const raw = JSON.stringify(realBody);
    const err = new DispatchError(`agentwallet 500: ${raw.slice(0, 1000)}`, {
      parsed: realBody,
      raw,
      status: 500,
      source: "agentwallet",
    });
    const classified = classifyPayError(err);
    expect(classified.kind).toBe("agentwallet_unreachable");
    const body = classified.details?.body as typeof realBody;
    // The full reason is in details.body — including the tx_error that
    // was truncated out of the old `message` string.
    expect(body.payment.tx_error).toBe(
      "EIP-3009 signature verification failed: nonce already used",
    );
  });

  test("unknown error kind without prefix matches → falls through to 'unknown'", () => {
    const classified = classifyPayError(new Error("some random javascript error"));
    expect(classified.kind).toBe("unknown");
    expect(classified.retryable).toBe(false);
  });
});
