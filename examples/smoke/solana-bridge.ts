#!/usr/bin/env bun
// Stage 1c smoke: faremeter-bridge handles `kind: solana` for x402.
// Structural — no real Solana RPC calls, no Devnet wallet needed.
// Verifies the bridge picks the right handler for each (kind, protocol) combo.

import { WalletRegistry } from "../../src/wallet/wallet-registry.ts";
import { buildHandlers, BridgeError } from "../../src/wallet/faremeter-bridge.ts";
import type { ToolDescriptor } from "../../src/types.ts";

let exitCode = 0;
function assert(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) exitCode = 1;
}

function makeDescriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    pay_protocol: "0.0.1",
    id: "test.tool",
    title: "Test",
    description: "Test descriptor",
    capabilities: ["test"],
    invocation: {
      method: "POST",
      url: "https://example.test/api",
    },
    payment: {
      protocol: "x402",
      network: "solana-devnet",
      currency: "USDC",
      price_hint: "0.001",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    },
    ...overrides,
  };
}

// Mock Solana wallet — minimal shape for type-checking the bridge wiring.
// (Real settlement would need a live wallet; this just verifies routing.)
const mockSolanaWallet = {
  network: "solana-devnet",
  publicKey: { toBase58: () => "MockPublicKey1111111111111111111111111111111" },
  partiallySignTransaction: async (tx: unknown) => tx,
  updateTransaction: async (tx: unknown) => tx,
};

const registry = new WalletRegistry({
  byNetwork: {
    "solana-devnet": {
      kind: "solana",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: mockSolanaWallet as any,
      label: "smoke",
      source: "solana",
    },
    "base": {
      kind: "evm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: { account: {}, address: "0x0000000000000000000000000000000000000001", chain: { id: 8453, name: "Base" } } as any,
      label: "smoke-evm",
      source: "evm",
    },
  },
  agent: "smoke:solana",
});

console.log("Solana x402 (with payment.asset):");
const r1 = buildHandlers(makeDescriptor(), registry);
assert("returns 1 handler", r1.handlers.length === 1);
assert("not free", r1.free === false);
assert("walletEntry kind=solana", r1.walletEntry?.kind === "solana");

console.log("\nSolana x402 (no payment.asset, falls back to known mint):");
const r2 = buildHandlers(
  makeDescriptor({
    payment: {
      protocol: "x402",
      network: "solana-devnet",
      currency: "USDC",
      price_hint: "0.001",
      // asset deliberately omitted — should fall back to KNOWN_SPL_MINTS
    },
  }),
  registry,
);
assert("falls back to known mint, returns handler", r2.handlers.length === 1);

console.log("\nSolana x402 on unknown network (no asset, no fallback):");
try {
  buildHandlers(
    makeDescriptor({
      payment: {
        protocol: "x402",
        network: "solana-mystery",
        currency: "USDC",
        price_hint: "0.001",
      },
    }),
    new WalletRegistry({
      byNetwork: {
        "solana-mystery": {
          kind: "solana",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: mockSolanaWallet as any,
          label: "x",
          source: "solana",
        },
      },
    }),
  );
  assert("should have thrown", false);
} catch (e) {
  const msg = (e as Error).message;
  if (e instanceof BridgeError && msg.includes("payment.asset")) {
    assert("BridgeError mentions payment.asset", true);
  } else {
    assert("expected BridgeError about payment.asset", false, msg);
  }
}

console.log("\nEVM x402 still works (regression check):");
const r3 = buildHandlers(
  makeDescriptor({
    payment: {
      protocol: "x402",
      network: "base",
      currency: "USDC",
      price_hint: "0.001",
    },
  }),
  registry,
);
assert("returns 1 handler", r3.handlers.length === 1);
assert("walletEntry kind=evm", r3.walletEntry?.kind === "evm");

console.log("\nFree path still works:");
const r4 = buildHandlers(
  makeDescriptor({
    payment: { protocol: "none" },
  }),
  registry,
);
assert("free=true, no handlers", r4.free === true && r4.handlers.length === 0);

console.log("\nMPP Solana — SPL token (CASH on mainnet, via faremeter registry):");
const r5 = buildHandlers(
  makeDescriptor({
    payment: {
      protocol: "mpp",
      network: "solana-mainnet",
      currency: "CASH",
      price_hint: "0.01",
      // no asset — should resolve via lookupKnownSPLToken("mainnet-beta", "CASH")
    },
  }),
  new WalletRegistry({
    byNetwork: {
      "solana-mainnet": {
        kind: "solana",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: { ...mockSolanaWallet, network: "solana-mainnet" } as any,
        label: "smoke",
        source: "solana",
      },
    },
  }),
);
assert("mppHandlers length=1", r5.mppHandlers.length === 1);
assert("standard handlers empty", r5.handlers.length === 0);
assert("not free", r5.free === false);

console.log("\nMPP Solana — explicit asset (CASH mint):");
const r6 = buildHandlers(
  makeDescriptor({
    payment: {
      protocol: "mpp",
      network: "solana-mainnet",
      currency: "CASH",
      price_hint: "0.01",
      asset: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
    },
  }),
  new WalletRegistry({
    byNetwork: {
      "solana-mainnet": {
        kind: "solana",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: { ...mockSolanaWallet, network: "solana-mainnet" } as any,
        label: "smoke",
        source: "solana",
      },
    },
  }),
);
assert("mppHandlers length=1", r6.mppHandlers.length === 1);

console.log("\nMPP Solana — native SOL:");
const r7 = buildHandlers(
  makeDescriptor({
    payment: {
      protocol: "mpp",
      network: "solana-mainnet",
      currency: "SOL",
      price_hint: "0.001",
    },
  }),
  new WalletRegistry({
    byNetwork: {
      "solana-mainnet": {
        kind: "solana",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: { ...mockSolanaWallet, network: "solana-mainnet" } as any,
        label: "smoke",
        source: "solana",
      },
    },
  }),
);
assert("native MPP handler returned", r7.mppHandlers.length === 1);

console.log("\nMPP Solana — unknown token, no asset, no fallback:");
try {
  buildHandlers(
    makeDescriptor({
      payment: {
        protocol: "mpp",
        network: "solana-mainnet",
        currency: "MYSTERY-TOKEN",
        price_hint: "0.01",
      },
    }),
    new WalletRegistry({
      byNetwork: {
        "solana-mainnet": {
          kind: "solana",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: { ...mockSolanaWallet, network: "solana-mainnet" } as any,
          label: "smoke",
          source: "solana",
        },
      },
    }),
  );
  assert("should have thrown", false);
} catch (e) {
  const msg = (e as Error).message;
  if (e instanceof BridgeError && msg.includes("payment.asset")) {
    assert("BridgeError mentions payment.asset (or SOL)", true);
  } else {
    assert("expected BridgeError", false, msg);
  }
}

console.log();
if (exitCode === 0) console.log("✓ Solana x402 + MPP bridge wiring works");
process.exit(exitCode);
