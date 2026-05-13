import { test, expect, describe } from "bun:test";
import {
  canonicalHost,
  entityIdFromHost,
  describeNetwork,
  isInfraHost,
  aliasCandidate,
} from "./host.ts";

describe("canonicalHost", () => {
  test("strips protocol + path + port + lowercases", () => {
    expect(canonicalHost("https://Api.Foo.com:8080/v1/resource?x=1")).toBe("api.foo.com");
    expect(canonicalHost("Api.Foo.com")).toBe("api.foo.com");
    expect(canonicalHost("//api.foo.com")).toBe("api.foo.com");
  });

  test("rejects localhost + loopback + .local", () => {
    expect(canonicalHost("localhost")).toBeNull();
    expect(canonicalHost("127.0.0.1")).toBeNull();
    expect(canonicalHost("foo.local")).toBeNull();
    expect(canonicalHost("")).toBeNull();
    expect(canonicalHost(null)).toBeNull();
    expect(canonicalHost(undefined)).toBeNull();
  });
});

describe("entityIdFromHost", () => {
  test("safe-slugifies", () => {
    expect(entityIdFromHost("api.foo.com")).toBe("api-foo-com");
    expect(entityIdFromHost("--Foo!.com--")).toBe("foo-com");
  });
});

describe("aliasCandidate (one prefix at a time, multi-step rollup via merge)", () => {
  test("strips a single known prefix", () => {
    expect(aliasCandidate("x402.foo.com")).toBe("foo.com");
    expect(aliasCandidate("api.foo.com")).toBe("foo.com");
    expect(aliasCandidate("mpp.foo.com")).toBe("foo.com");
    expect(aliasCandidate("payments.foo.com")).toBe("foo.com");
    expect(aliasCandidate("www.foo.com")).toBe("foo.com");
  });

  test("does NOT strip two prefixes at once — merge loop handles transitive case", () => {
    // x402.api.foo.com → api.foo.com (one step).
    // If api.foo.com is in allHosts, merge.ts walks the chain to foo.com.
    // If we stripped both prefixes here, we'd skip past the intermediate
    // parent that the bazaar uses.
    expect(aliasCandidate("x402.api.foo.com")).toBe("api.foo.com");
    expect(aliasCandidate("mpp.api.foo.com")).toBe("api.foo.com");
  });

  test("returns null for hosts without a known prefix", () => {
    expect(aliasCandidate("foo.com")).toBeNull();
    expect(aliasCandidate("subdomain.foo.com")).toBeNull();
  });
});

describe("describeNetwork", () => {
  test("CAIP-2 EVM mainnets map to friendly names + correct tiers", () => {
    expect(describeNetwork("eip155:8453")).toMatchObject({
      name: "Base",
      tier: "evm_rollup",
      mainnet: true,
    });
    expect(describeNetwork("eip155:1")).toMatchObject({ name: "Ethereum", tier: "evm_l1" });
    expect(describeNetwork("eip155:42161")).toMatchObject({ name: "Arbitrum", tier: "evm_rollup" });
  });

  test("Tempo chain id 4217 maps to Tempo (not 'Chain 4217')", () => {
    expect(describeNetwork("eip155:4217")).toMatchObject({
      name: "Tempo",
      tier: "alt_l1",
      mainnet: true,
    });
  });

  test("v1 friendly aliases case-insensitive", () => {
    expect(describeNetwork("base")).toMatchObject({ name: "Base" });
    expect(describeNetwork("Base")).toMatchObject({ name: "Base" });
    expect(describeNetwork("BASE")).toMatchObject({ name: "Base" });
    expect(describeNetwork("solana")).toMatchObject({ name: "Solana" });
    expect(describeNetwork("tempo")).toMatchObject({ name: "Tempo" });
  });

  test("solana CAIP-2 (full + truncated)", () => {
    expect(
      describeNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpgttKVHvjz4w"),
    ).toMatchObject({ name: "Solana", tier: "solana" });
  });

  test("testnet flagged not-mainnet", () => {
    expect(describeNetwork("eip155:84532").mainnet).toBe(false);
  });

  test("unknown EVM chain → 'Chain N' but still mainnet=true (heuristic)", () => {
    expect(describeNetwork("eip155:9999999")).toMatchObject({
      name: "Chain 9999999",
      mainnet: true,
    });
  });

  test("unknown raw string → name passthrough, tier=unknown", () => {
    expect(describeNetwork("totally-new-rail")).toMatchObject({
      tier: "unknown",
      mainnet: false,
    });
  });
});

describe("isInfraHost", () => {
  test.each([
    ["abc.execute-api.us-east-1.amazonaws.com", true],
    ["my-thing.vercel.app", true],
    ["api.foo.workers.dev", true],
    ["thing.fly.dev", true],
    ["api.openai.com", false],
    ["coingecko.com", false],
    [null, false],
    [undefined, false],
  ])("isInfraHost(%p) = %p", (host, expected) => {
    expect(isInfraHost(host as string | null | undefined)).toBe(expected);
  });
});
