// payForTool — the orchestrator. Implements the SPEC WalletAdapter.
//
//   1. Resolve the descriptor (lock → manifest → URL → catalog).
//   2. Validate params (deferred to Stage 1c — currently passthrough).
//   3. Check budget (deferred to Stage 1c).
//   4. Pick faremeter handler(s) from the protocol bridge.
//   5. Build the invocation, wrap fetch, call the seller.
//   6. Build a signed receipt from the response.
//   7. Return { body, receipt }.

import { wrap } from "@faremeter/fetch";
import type {
  PayForToolInput,
  PayForToolResult,
  Receipt,
  ToolDescriptor,
} from "../types.ts";
import { resolveTool } from "../manifest/resolve.ts";
import type { WalletRegistry } from "./wallet-registry.ts";
import { buildHandlers, BridgeError } from "./faremeter-bridge.ts";
import { buildReceipt } from "./receipt.ts";
import type { AuditKeyPair } from "./audit-key.ts";
import { canonicalize } from "../canonical.ts";

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

export interface DispatchContext {
  registry: WalletRegistry;
  auditKey: AuditKeyPair;
  /** Optional fetch override (test seam). */
  fetchImpl?: typeof fetch;
}

export async function payForTool(
  input: PayForToolInput,
  ctx: DispatchContext,
): Promise<PayForToolResult> {
  // 1. Resolve descriptor.
  const resolved = await resolveTool(input.name, {
    ...(input.manifest !== undefined && { manifest: input.manifest }),
    ...(input.lock !== undefined && { lock: input.lock }),
    ...(input.catalog !== undefined && { catalog: input.catalog }),
    ...(ctx.fetchImpl !== undefined && { fetchImpl: ctx.fetchImpl }),
  });
  const descriptor = resolved.descriptor;

  // 4. Pick handler(s) via the bridge.
  let bridge;
  try {
    bridge = buildHandlers(descriptor, ctx.registry);
  } catch (e) {
    if (e instanceof BridgeError) {
      throw new DispatchError(`bridge: ${e.message}`);
    }
    throw e;
  }

  // 5. Build invocation.
  const invocationUrl = descriptor.invocation.url;
  const method = descriptor.invocation.method.toUpperCase();
  const requestBody =
    method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input.params);
  const requestHash = await sha256Of(requestBody ?? "");

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const fetcher = bridge.free
    ? fetchImpl
    : wrap(fetchImpl, {
        handlers: bridge.handlers,
        mppHandlers: bridge.mppHandlers,
      });

  const t0 = Date.now();
  const res = await fetcher(invocationUrl, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(requestBody !== undefined && { body: requestBody }),
  });
  const elapsedMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    throw new DispatchError(
      `seller returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const responseText = await res.text();
  const responseHash = await sha256Of(responseText);
  const body = JSON.parse(responseText) as unknown;

  // 6. Extract settled payment metadata.
  // The test endpoint at registry.frames.ag returns { ..., payment: { network, payer, txHash } }
  // Sniff that shape; otherwise fall back to descriptor hints.
  const settled = sniffSettlement(body, descriptor);

  // 7. Build receipt.
  const network = descriptor.payment.network ?? "unknown";
  const wallet_id = ctx.registry.walletId(network) ?? "unknown:unknown";
  const wallet_address =
    ctx.registry.addressFor(network) ?? settled.payer ?? "unknown";
  const amount = bridge.free ? "0" : settled.amount ?? descriptor.payment.price_hint ?? "0";
  const currency = bridge.free
    ? descriptor.payment.currency ?? "NONE"
    : descriptor.payment.currency ?? "UNKNOWN";

  const receiptInput = {
    descriptor,
    descriptor_id: resolved.descriptor_id,
    ...(input.name !== descriptor.id && resolved.via !== "url"
      ? { tool_local_name: input.name }
      : {}),
    params: input.params,
    wallet_id,
    wallet_address,
    amount,
    currency,
    network,
    ...(descriptor.payment.facilitator !== undefined && {
      facilitator_url: descriptor.payment.facilitator,
    }),
    ...(settled.tx_hash !== undefined && { tx_hash: settled.tx_hash }),
    request_hash: requestHash,
    response_hash: responseHash,
    agent: ctx.registry.agent(),
    auditKey: ctx.auditKey,
  };

  const receipt: Receipt = await buildReceipt(receiptInput);
  // elapsedMs is currently unused but kept locally for future timing receipts.
  void elapsedMs;
  return { body, receipt };
}

interface SettledMetadata {
  amount?: string;
  payer?: string;
  tx_hash?: string;
}

function sniffSettlement(body: unknown, descriptor: ToolDescriptor): SettledMetadata {
  // Frames Registry / x402v2 sellers commonly return a top-level "payment" object.
  if (typeof body === "object" && body !== null && "payment" in body) {
    const p = (body as { payment: unknown }).payment;
    if (typeof p === "object" && p !== null) {
      const obj = p as Record<string, unknown>;
      return {
        ...(typeof obj["amount"] === "string" && { amount: obj["amount"] }),
        ...(typeof obj["payer"] === "string" && { payer: obj["payer"] }),
        ...(typeof obj["txHash"] === "string" && { tx_hash: obj["txHash"] }),
      };
    }
  }
  // Fall back to descriptor's price_hint
  return {
    ...(descriptor.payment.price_hint !== undefined && {
      amount: descriptor.payment.price_hint,
    }),
  };
}

async function sha256Of(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  let s = "";
  for (const b of new Uint8Array(hash)) s += String.fromCharCode(b);
  const b64 = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "sha256-" + b64;
}

// Re-export canonicalize for any caller that wants it (params_hash etc.)
export { canonicalize };
