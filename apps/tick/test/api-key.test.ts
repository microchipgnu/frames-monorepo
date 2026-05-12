// Tests for the bearer-token API key auth layer.

import { describe, expect, test } from "bun:test";
import { extractBearerToken, lookupApiKey, parseApiKeys } from "../src/api-key.ts";

// ---------------------------------------------------------------------------
// parseApiKeys
// ---------------------------------------------------------------------------

describe("parseApiKeys()", () => {
  test("undefined / empty / whitespace → empty array", () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys("")).toEqual([]);
    expect(parseApiKeys("   ")).toEqual([]);
    expect(parseApiKeys(",,,")).toEqual([]);
  });

  test("single entry", () => {
    expect(parseApiKeys("k_abc:frames-runtime:0xAlice")).toEqual([
      { key: "k_abc", agent: "frames-runtime:0xAlice" },
    ]);
  });

  test("multiple entries with whitespace", () => {
    expect(parseApiKeys(" k_alpha:frames-runtime:0xA , k_beta:frames-runtime:0xB ")).toEqual([
      { key: "k_alpha", agent: "frames-runtime:0xA" },
      { key: "k_beta", agent: "frames-runtime:0xB" },
    ]);
  });

  test("agent identifier can contain colons", () => {
    // The agent is everything after the FIRST colon, so this works:
    // `k_x:frames-runtime:0xA` → key=`k_x`, agent=`frames-runtime:0xA`
    const r = parseApiKeys("k_x:frames-runtime:0xAlice");
    expect(r[0]!.agent).toBe("frames-runtime:0xAlice");
  });

  test("entries without colons are dropped", () => {
    expect(parseApiKeys("no_colon_here,k_ok:frames-runtime:0xA")).toEqual([
      { key: "k_ok", agent: "frames-runtime:0xA" },
    ]);
  });

  test("entries with empty halves are dropped", () => {
    expect(parseApiKeys(":missing-key,k_only:,k_ok:frames-runtime:0xA")).toEqual([
      { key: "k_ok", agent: "frames-runtime:0xA" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe("extractBearerToken()", () => {
  test("returns null when no auth header present", () => {
    expect(extractBearerToken(new Request("https://x/"))).toBeNull();
  });

  test("Authorization: Bearer <token>", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer abc123" } });
    expect(extractBearerToken(r)).toBe("abc123");
  });

  test("case-insensitive `bearer`", () => {
    const r = new Request("https://x/", { headers: { authorization: "bearer abc123" } });
    expect(extractBearerToken(r)).toBe("abc123");
  });

  test("X-Tick-API-Key fallback", () => {
    const r = new Request("https://x/", { headers: { "x-tick-api-key": "abc123" } });
    expect(extractBearerToken(r)).toBe("abc123");
  });

  test("Authorization takes precedence over X-Tick-API-Key", () => {
    const r = new Request("https://x/", {
      headers: { authorization: "Bearer from_auth", "x-tick-api-key": "from_x_header" },
    });
    expect(extractBearerToken(r)).toBe("from_auth");
  });

  test("Authorization without Bearer prefix → null (don't accept raw)", () => {
    const r = new Request("https://x/", { headers: { authorization: "abc123" } });
    expect(extractBearerToken(r)).toBeNull();
  });

  test("trims whitespace around the token", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer   abc123   " } });
    expect(extractBearerToken(r)).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// lookupApiKey
// ---------------------------------------------------------------------------

describe("lookupApiKey()", () => {
  test("no header → matched:false (fall through to other auth)", () => {
    const r = new Request("https://x/");
    expect(lookupApiKey(r, "k_a:frames-runtime:0xA")).toEqual({ matched: false });
  });

  test("header present + key matches → matched:true with agent", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer k_a" } });
    const result = lookupApiKey(r, "k_a:frames-runtime:0xA,k_b:frames-runtime:0xB");
    expect(result.matched).toBe(true);
    expect(result.agent).toBe("frames-runtime:0xA");
  });

  test("header present + no keys configured → unauthorized (fail closed)", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer k_a" } });
    const result = lookupApiKey(r, undefined);
    expect(result.matched).toBe(false);
    expect(result.unauthorized).toBe(true);
    expect(result.reason).toContain("TICK_API_KEYS");
  });

  test("header present + key DOESN'T match → unauthorized", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer k_wrong" } });
    const result = lookupApiKey(r, "k_a:frames-runtime:0xA");
    expect(result.matched).toBe(false);
    expect(result.unauthorized).toBe(true);
    expect(result.reason).toContain("does not match");
  });

  test("X-Tick-API-Key header works the same as Authorization", () => {
    const r = new Request("https://x/", { headers: { "x-tick-api-key": "k_a" } });
    const result = lookupApiKey(r, "k_a:frames-runtime:0xA");
    expect(result.matched).toBe(true);
    expect(result.agent).toBe("frames-runtime:0xA");
  });

  test("matches the second key, not the first", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer k_b" } });
    const result = lookupApiKey(r, "k_a:frames-runtime:0xA,k_b:frames-runtime:0xB,k_c:frames-runtime:0xC");
    expect(result.matched).toBe(true);
    expect(result.agent).toBe("frames-runtime:0xB");
  });

  test("similar-but-not-equal keys do not match (constant-time)", () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer k_aa" } });
    const result = lookupApiKey(r, "k_a:frames-runtime:0xA");
    expect(result.matched).toBe(false);
    expect(result.unauthorized).toBe(true);
  });
});
