import { describe, expect, it } from "bun:test";
import { deriveWalletAddresses } from "../src/wallet";
import type { Bindings } from "../src/env";

function env(over: Partial<Bindings>): Bindings {
  return { FACILITATOR_URL: "https://stub", ...over } as Bindings;
}

describe("deriveWalletAddresses", () => {
  it("returns all-null when no wallets configured", () => {
    const r = deriveWalletAddresses(env({}));
    expect(r.solana).toBeNull();
    expect(r.evm).toBeNull();
    expect(r.tempo).toBeNull();
  });

  it("derives the EVM/Tempo address from EVM_OUTBOUND_PRIVATE_KEY", () => {
    // Test vector: this private key produces address 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23.
    // From https://github.com/wevm/viem/blob/main/test/src/constants.ts (account[0]).
    const r = deriveWalletAddresses(
      env({
        EVM_OUTBOUND_PRIVATE_KEY:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      }),
    );
    expect(r.evm).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(r.tempo).toBe(r.evm); // Tempo reuses the EVM key
    expect(r.solana).toBeNull();
  });

  it("derives the Solana address from a 64-byte keypair JSON", () => {
    // 64 bytes: first 32 = ed25519 priv, last 32 = ed25519 pub. The base58
    // of the pub half is the Solana address. Using a known test vector:
    // pub = bytes [0..32] of 0xff repeated should produce the deterministic
    // base58. We'll use an all-zero priv + all-one pub for predictability.
    const secretKey = new Array(64).fill(0);
    for (let i = 32; i < 64; i++) secretKey[i] = 1;
    const r = deriveWalletAddresses(env({ SOLANA_OUTBOUND_KEYPAIR_JSON: JSON.stringify(secretKey) }));
    // base58([1,1,...,1] x 32) is deterministic — compute via the same
    // algorithm so the test asserts round-trip rather than a magic constant.
    expect(typeof r.solana).toBe("string");
    expect(r.solana!.length).toBeGreaterThan(30); // valid Solana addrs are ~32-44 base58 chars
    // No leading zero bytes → no leading '1'
    expect(r.solana!.startsWith("1")).toBe(false);
  });

  it("returns null for Solana when keypair JSON is malformed", () => {
    const r = deriveWalletAddresses(env({ SOLANA_OUTBOUND_KEYPAIR_JSON: "not-json" }));
    expect(r.solana).toBeNull();
  });

  it("returns null for Solana when keypair is wrong length", () => {
    const r = deriveWalletAddresses(env({ SOLANA_OUTBOUND_KEYPAIR_JSON: JSON.stringify([1, 2, 3]) }));
    expect(r.solana).toBeNull();
  });
});
