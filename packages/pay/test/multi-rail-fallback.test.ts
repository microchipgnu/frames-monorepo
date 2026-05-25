// Multi-rail runtime fallback in payForTool.
//
// Before this PR: selectPaymentOption picked the first option whose bridge
// built cleanly and (under "block") whose balance covered the price_hint.
// If THAT selected option's dispatch then failed at runtime — e.g.
// agentwallet returned 500 because the chosen rail's wallet was empty —
// payForTool threw without trying the remaining options in
// descriptor.payment.accepts[].
//
// After this PR: payForTool loops over [primary, ...accepts[]]. For each
// option it tries selection, then dispatch. A DispatchError from the
// dispatch path means "try the next rail." Only when every option is
// exhausted does payForTool throw — and the error now lists both
// selection-time and runtime failures.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payForTool, DispatchError } from "../src/wallet/dispatch.ts";
import { WalletRegistry } from "../src/wallet/wallet-registry.ts";
import { loadOrCreateAuditKey, type AuditKeyPair } from "../src/wallet/audit-key.ts";
import { descriptorId } from "../src/descriptor-id.ts";
import type { ToolDescriptor, Lockfile } from "../src/types.ts";

let TMP: string;
let auditKey: AuditKeyPair;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), "pay-multi-rail-"));
  auditKey = await loadOrCreateAuditKey(join(TMP, "audit-key.json"));
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeDescriptor(primaryNetwork: string, alternateNetworks: string[]): ToolDescriptor {
  return {
    pay_protocol: "0.0.1",
    id: "test.multi-rail",
    title: "test multi-rail",
    description: "free endpoint advertised on multiple networks for audit parity",
    capabilities: ["test"],
    invocation: { method: "POST", url: "https://example.test/api" },
    payment: {
      protocol: "none",
      network: primaryNetwork,
      currency: "USDC",
      accepts: alternateNetworks.map((network) => ({
        protocol: "none",
        network,
        currency: "USDC",
      })),
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

describe("multi-rail runtime fallback", () => {
  test("with no wallets configured for any rail, DispatchError lists every attempted option", async () => {
    const descriptor = makeDescriptor("base", ["solana-mainnet", "polygon"]);
    const registry = new WalletRegistry({ byNetwork: {}, agent: "test:multi-rail" });

    try {
      await payForTool(
        { name: descriptor.id, params: {}, lock: await lockFor(descriptor) },
        { registry, auditKey, persistence: { skipPersistence: true } },
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DispatchError);
      const msg = (e as Error).message;
      // Aggregated error must mention all three networks plus the count.
      expect(msg).toContain("base");
      expect(msg).toContain("solana-mainnet");
      expect(msg).toContain("polygon");
      expect(msg).toContain("3 payment options");
      // Each entry should record the "no_wallet_for_network" status from
      // selection, since no wallets are configured anywhere.
      expect(msg).toContain("no_wallet_for_network");
    }
  });

  test("single-rail descriptor still works (no accepts[])", async () => {
    // Sanity check: the new loop must not regress single-rail behaviour.
    const descriptor: ToolDescriptor = {
      pay_protocol: "0.0.1",
      id: "test.single-rail",
      title: "test single",
      description: "no alternates",
      capabilities: ["test"],
      invocation: { method: "POST", url: "https://example.test/api" },
      payment: { protocol: "none", network: "base", currency: "USDC" },
    };
    const registry = new WalletRegistry({ byNetwork: {}, agent: "test:multi-rail" });

    try {
      await payForTool(
        { name: descriptor.id, params: {}, lock: await lockFor(descriptor) },
        { registry, auditKey, persistence: { skipPersistence: true } },
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DispatchError);
      const msg = (e as Error).message;
      // Single option → "1 payment option" (singular).
      expect(msg).toContain("1 payment option");
      expect(msg).not.toContain("1 payment options");
    }
  });
});
