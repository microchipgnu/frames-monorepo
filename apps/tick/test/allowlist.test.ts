// Tests for the agent allowlist gate.

import { describe, expect, test } from "bun:test";
import { checkAllowlist, parseAllowlist } from "../src/allowlist.ts";

describe("parseAllowlist()", () => {
  test("undefined / empty returns empty array", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("   ")).toEqual([]);
  });

  test("splits on commas + trims whitespace", () => {
    expect(parseAllowlist("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseAllowlist("  a , b  ,c ")).toEqual(["a", "b", "c"]);
  });

  test("filters out empty entries from leading/trailing commas", () => {
    expect(parseAllowlist(",a,,b,")).toEqual(["a", "b"]);
  });
});

describe("checkAllowlist()", () => {
  test("closed by default when env unset", () => {
    const r = checkAllowlist("frames-runtime:0xabc", undefined);
    expect(r.allowed).toBe(false);
    expect(r.open).toBe(false);
    expect(r.entries).toBe(0);
    expect(r.reason).toContain("Hosted /run is closed");
  });

  test("closed by default when env empty", () => {
    const r = checkAllowlist("frames-runtime:0xabc", "");
    expect(r.allowed).toBe(false);
    expect(r.entries).toBe(0);
  });

  test("`*` sentinel opens the gate for any agent", () => {
    const r = checkAllowlist("frames-runtime:0xdeadbeef", "*");
    expect(r.allowed).toBe(true);
    expect(r.open).toBe(true);
    expect(r.entries).toBe(1);
  });

  test("`*` mixed with other entries still opens the gate", () => {
    const r = checkAllowlist("ip:7f1a", "frames-runtime:0xabc,*,ip:9999");
    expect(r.allowed).toBe(true);
    expect(r.open).toBe(true);
  });

  test("exact match allows", () => {
    const r = checkAllowlist("frames-runtime:0xabc", "frames-runtime:0xabc,frames-runtime:0xdef");
    expect(r.allowed).toBe(true);
    expect(r.open).toBe(false);
    expect(r.entries).toBe(2);
  });

  test("non-match denies with helpful reason", () => {
    const r = checkAllowlist("ip:nope", "frames-runtime:0xabc,frames-runtime:0xdef");
    expect(r.allowed).toBe(false);
    expect(r.open).toBe(false);
    expect(r.entries).toBe(2);
    expect(r.reason).toContain("ip:nope");
    expect(r.reason).toContain("not in TICK_ALLOWED_AGENTS");
  });

  test("trailing `*` glob matches prefix", () => {
    const r = checkAllowlist("ip:7f1a4b2c", "ip:7f1a*,frames-runtime:0xabc");
    expect(r.allowed).toBe(true);
  });

  test("trailing `*` glob does NOT match wrong prefix", () => {
    const r = checkAllowlist("ip:88aa4b2c", "ip:7f1a*");
    expect(r.allowed).toBe(false);
  });

  test("trailing `*` glob matches the prefix itself", () => {
    // A glob like "ip:*" should match "ip:" exactly + anything after.
    const r = checkAllowlist("ip:", "ip:*");
    expect(r.allowed).toBe(true);
  });

  test("case-sensitive matching (addresses are normalized upstream)", () => {
    // The allowlist trusts whatever the upstream identity-resolver produced.
    // It does NOT lowercase EVM addresses; that's the resolver's job.
    const r = checkAllowlist("frames-runtime:0xABC", "frames-runtime:0xabc");
    expect(r.allowed).toBe(false);
  });

  test("CLI-style identity passes too — the allowlist doesn't care about prefix shape", () => {
    // Operator can allowlist any agent string. The allowlist is shape-agnostic.
    const r = checkAllowlist("custom-runtime:tenant-42", "custom-runtime:tenant-42");
    expect(r.allowed).toBe(true);
  });
});
