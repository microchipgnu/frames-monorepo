// agentwallet rail hint: the delegated dispatch must tell agentwallet WHICH
// chain the dispatcher selected, using agentwallet's own request schema.
//
// agentwallet's /actions/x402/fetch honors `preferredChain` ('evm' | 'solana'
// | 'auto') and `preferredToken`. It does NOT read `payment_rail` (unknown
// body keys are stripped). Before the fix, pay sent only `payment_rail`, so
// agentwallet always ran `auto` and could route a Base/USDC selection onto a
// different rail (e.g. an MPP/Tempo challenge). These tests pin that the
// dispatcher now translates the descriptor's network → `preferredChain` and
// the currency → `preferredToken` in the request body sent to agentwallet.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payForTool } from "../src/wallet/dispatch.ts";
import { WalletRegistry, type WalletEntry } from "../src/wallet/wallet-registry.ts";
import { loadOrCreateAuditKey, type AuditKeyPair } from "../src/wallet/audit-key.ts";
import { descriptorId } from "../src/descriptor-id.ts";
import type { ToolDescriptor, Lockfile } from "../src/types.ts";

let TMP: string;
let auditKey: AuditKeyPair;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), "pay-rail-hint-"));
  auditKey = await loadOrCreateAuditKey(join(TMP, "audit-key.json"));
  // Keep receipt persistence off the user's real ~/.frames/pay/events.ndjson —
  // the delegated path persists with a default resolver, so point it at TMP.
  process.env["PAY_FRAME_DATASET"] = TMP;
});

afterAll(() => {
  delete process.env["PAY_FRAME_DATASET"];
  rmSync(TMP, { recursive: true, force: true });
});

/** A single-rail x402v2 descriptor on `network`, settled in `currency`. */
function makeDescriptor(network: string, currency: string): ToolDescriptor {
  return {
    pay_protocol: "0.0.1",
    id: "test.rail-hint",
    title: "test rail hint",
    description: "x402v2 endpoint used to assert the agentwallet rail hint body",
    capabilities: ["test"],
    invocation: { method: "POST", url: "https://seller.test/api/thing" },
    payment: {
      protocol: "x402v2",
      network,
      currency,
      price_hint: "0.06",
    },
  };
}

async function lockFor(descriptor: ToolDescriptor): Promise<Lockfile> {
  const id = await descriptorId(descriptor);
  return {
    pay_protocol: "0.0.1",
    lockfile_version: 1,
    resolved: {
      [descriptor.id]: {
        source: { url: "https://catalog.test/tools/" + descriptor.id },
        descriptor_id: id,
        fetched_at: new Date().toISOString(),
        descriptor,
      },
    },
  };
}

/** A delegated agentwallet entry for `network`. */
function agentwalletEntry(): WalletEntry {
  return {
    kind: "delegated",
    provider: "agentwallet",
    baseUrl: "https://frames.ag",
    apiToken: "test-token",
    username: "tester",
    addresses: { evm: "0xBd9EB8899d7207bEB35A140010E154438a25E55f", solana: "AyyQz8tScHpiAh7S3v8XXhxHbfvfSiErLGur11SmegRc" },
    label: "my-agentwallet",
    source: "agentwallet",
  };
}

/**
 * A fake fetch that records the body POSTed to agentwallet's x402/fetch
 * endpoint and returns a successful settlement on `settledChain`.
 */
function captureFetch(settledChain: string) {
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    captured.push({ url, body });
    return new Response(
      JSON.stringify({
        success: true,
        response: { status: 200, body: { ok: true } },
        payment: { chain: settledChain, amountFormatted: "0.06 USDC", recipient: "0xCfA26F13c6C18307033EcE13BBb8F470dA5b4dbE" },
        paid: true,
        attempts: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { captured, fetchImpl };
}

describe("agentwallet delegated dispatch — rail hint", () => {
  test("base/USDC descriptor sends preferredChain:'evm' + preferredToken:'USDC'", async () => {
    const descriptor = makeDescriptor("base", "USDC");
    const registry = new WalletRegistry({ byNetwork: { base: agentwalletEntry() }, agent: "test:rail-hint" });
    const { captured, fetchImpl } = captureFetch("eip155:8453");

    await payForTool(
      { name: descriptor.id, params: { q: "x" }, lock: await lockFor(descriptor) },
      { registry, auditKey, fetchImpl, persistence: { skipPersistence: true } },
    );

    const call = captured.find((c) => c.url.includes("/actions/x402/fetch"));
    expect(call).toBeDefined();
    expect(call!.body["preferredChain"]).toBe("evm");
    expect(call!.body["preferredToken"]).toBe("USDC");
    // It must NOT silently rely on the stripped legacy field alone.
    expect(call!.body).toHaveProperty("preferredChain");
  });

  test("solana descriptor sends preferredChain:'solana'", async () => {
    const descriptor = makeDescriptor("solana-mainnet", "USDC");
    const registry = new WalletRegistry({ byNetwork: { "solana-mainnet": agentwalletEntry() }, agent: "test:rail-hint" });
    const { captured, fetchImpl } = captureFetch("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");

    await payForTool(
      { name: descriptor.id, params: {}, lock: await lockFor(descriptor) },
      { registry, auditKey, fetchImpl, persistence: { skipPersistence: true } },
    );

    const call = captured.find((c) => c.url.includes("/actions/x402/fetch"));
    expect(call).toBeDefined();
    expect(call!.body["preferredChain"]).toBe("solana");
  });

  test("eip155 CAIP-2 network also maps to 'evm'", async () => {
    const descriptor = makeDescriptor("eip155:8453", "USDC");
    const registry = new WalletRegistry({ byNetwork: { "eip155:8453": agentwalletEntry() }, agent: "test:rail-hint" });
    const { captured, fetchImpl } = captureFetch("eip155:8453");

    await payForTool(
      { name: descriptor.id, params: {}, lock: await lockFor(descriptor) },
      { registry, auditKey, fetchImpl, persistence: { skipPersistence: true } },
    );

    const call = captured.find((c) => c.url.includes("/actions/x402/fetch"));
    expect(call!.body["preferredChain"]).toBe("evm");
  });
});
