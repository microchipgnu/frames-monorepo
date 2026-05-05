// Build + Ed25519-sign Receipt objects per pay/SPEC.md.

import type { Receipt, ToolDescriptor } from "../types.ts";
import { canonicalize } from "../canonical.ts";
import type { AuditKeyPair } from "./audit-key.ts";
import { base64urlEncode } from "./audit-key.ts";

export interface BuildReceiptInput {
  descriptor: ToolDescriptor;
  descriptor_id: string;
  tool_local_name?: string;
  params: unknown;
  /** Per-call wallet identity. */
  wallet_id: string;
  wallet_address: string;
  /** Settled payment details (extracted from the seller's response). */
  amount: string;
  currency: string;
  network: string;
  facilitator_url?: string;
  tx_hash?: string;
  /** Hashes of the request/response bodies. */
  request_hash?: string;
  response_hash?: string;
  agent: string;
  auditKey: AuditKeyPair;
}

const PAY_PROTOCOL = "0.0.1";

export async function buildReceipt(input: BuildReceiptInput): Promise<Receipt> {
  const params_hash = await sha256JcsHex(input.params);

  const unsigned: Omit<Receipt, "signature"> = {
    pay_protocol: PAY_PROTOCOL,
    id: ulid(),
    ts: new Date().toISOString(),
    ...(input.tool_local_name !== undefined && {
      tool_local_name: input.tool_local_name,
    }),
    tool_id: input.descriptor.id,
    descriptor_id: input.descriptor_id,
    params_hash,
    protocol: input.descriptor.payment.protocol,
    wallet_id: input.wallet_id,
    wallet_address: input.wallet_address,
    amount: input.amount,
    currency: input.currency,
    network: input.network,
    ...(input.facilitator_url !== undefined && {
      facilitator_url: input.facilitator_url,
    }),
    ...(input.tx_hash !== undefined && { tx_hash: input.tx_hash }),
    ...(input.request_hash !== undefined && {
      request_hash: input.request_hash,
    }),
    ...(input.response_hash !== undefined && {
      response_hash: input.response_hash,
    }),
    agent: input.agent,
  };

  const signature = await signReceipt(unsigned, input.auditKey);
  return { ...unsigned, signature };
}

export async function verifyReceipt(receipt: Receipt, publicKey: Uint8Array): Promise<boolean> {
  const { signature, ...unsigned } = receipt;
  const sigBytes = parseSignature(signature);
  if (!sigBytes) return false;
  const buf = new TextEncoder().encode(canonicalize(unsigned));
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    sigBytes as BufferSource,
    buf as BufferSource,
  );
}

async function signReceipt(
  unsigned: Omit<Receipt, "signature">,
  auditKey: AuditKeyPair,
): Promise<string> {
  const buf = new TextEncoder().encode(canonicalize(unsigned));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    auditKey.privateKey,
    buf,
  );
  return "ed25519:" + base64urlEncode(new Uint8Array(sig));
}

function parseSignature(sig: string): Uint8Array | null {
  if (!sig.startsWith("ed25519:")) return null;
  const b64u = sig.slice("ed25519:".length);
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const b64 = (b64u + pad).replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256JcsHex(value: unknown): Promise<string> {
  const buf = new TextEncoder().encode(canonicalize(value));
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return "sha256-" + base64urlEncode(new Uint8Array(hash));
}

/** Tiny ULID for receipt IDs. Sortable, ~120 bits of entropy. */
function ulid(): string {
  const time = Date.now().toString(36).padStart(10, "0").toUpperCase();
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let randStr = "";
  for (const b of rand) randStr += b.toString(36).padStart(2, "0").toUpperCase();
  return `${time}-${randStr.slice(0, 16)}`;
}
