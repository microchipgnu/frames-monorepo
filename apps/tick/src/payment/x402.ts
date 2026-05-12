// x402 v2 inbound verify + settle, against any spec-compliant facilitator.
//
// Compatible with:
//   - Coinbase Developer Platform (CDP) `/v2/x402/verify` + `/v2/x402/settle`
//   - Faremeter v0.21.0+ (negotiates to v2 when both sides support it)
//   - Any other x402 v2 facilitator implementation
//
// Spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
//
// Wire format (verified 2026-05-12):
//   Header:  PAYMENT-SIGNATURE: <base64-encoded JSON PaymentPayload>
//   verify:  POST { x402Version, paymentPayload, paymentRequirements }
//            → { isValid, invalidReason?, payer? }
//   settle:  POST { x402Version, paymentPayload, paymentRequirements }
//            → { success, errorReason?, payer?, transaction, network, amount? }
//
// Today's /run handler is "verify-optional" when no facilitator configured
// (dev / local). When FACILITATOR_URL is set we're strict: missing header →
// 402 challenge with PaymentRequirements; bad header → 401; valid →
// dispatch op + settle on success.

import { log } from "../util/log";
import type {
  FacilitatorSettleResponse,
  FacilitatorVerifyResponse,
  PaymentPayload,
  PaymentRequirements,
} from "./types";

const X402_VERSION = 2;

export interface X402VerifyResult {
  /** True when the facilitator accepted the signature OR no header was sent in optional mode. */
  ok: boolean;
  /** Wallet address from the verified payload — the authenticated identity. */
  payer?: string;
  /** The decoded PaymentPayload — caller stashes this for the eventual settle call. */
  paymentPayload?: PaymentPayload;
  /** Error message when ok=false. */
  error?: string;
  /** True when we'd normally have returned 402 but optional mode let us through. */
  skipped?: boolean;
}

export interface X402SettleResult {
  ok: boolean;
  /** On-chain tx hash from the facilitator. */
  transaction?: string;
  /** Network the settlement landed on. */
  network?: string;
  /** Actual settled amount in smallest unit (USDC = 6 decimals). May be less than paymentRequirements.amount under `upto`. */
  amount?: string;
  error?: string;
}

/**
 * Verify the inbound x402 v2 payment header against the facilitator.
 *
 * Reads `PAYMENT-SIGNATURE` (base64-encoded JSON of a PaymentPayload).
 *
 * When `optional` is true (dev mode) and no header is present, returns ok
 * with `skipped: true`. When `optional` is false and the header is missing,
 * returns ok:false so the caller can emit a 402 challenge.
 */
export async function verifyInboundX402(
  req: Request,
  facilitatorUrl: string | undefined,
  paymentRequirements: PaymentRequirements | null,
  opts: { optional?: boolean; facilitatorAuthHeader?: Record<string, string> } = {},
): Promise<X402VerifyResult> {
  const optional = opts.optional ?? true;
  const headerValue = req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("payment-signature");

  if (!headerValue) {
    if (optional) {
      log.warn("x402_verify_skipped", { reason: "no_payment_header", optional: true });
      return { ok: true, skipped: true };
    }
    return { ok: false, error: "missing PAYMENT-SIGNATURE header" };
  }

  if (!facilitatorUrl) {
    if (optional) {
      log.warn("x402_verify_skipped", { reason: "no_facilitator_url", optional: true });
      return { ok: true, skipped: true };
    }
    return { ok: false, error: "FACILITATOR_URL not configured" };
  }

  if (!paymentRequirements) {
    return { ok: false, error: "server cannot quote PaymentRequirements (TICK_PAY_TO_ADDRESS unset)" };
  }

  // Decode the base64 PaymentPayload.
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodePaymentPayload(headerValue);
  } catch (e) {
    return { ok: false, error: `malformed PAYMENT-SIGNATURE: ${(e as Error).message}` };
  }

  try {
    const res = await fetch(facilitatorUrl.replace(/\/$/, "") + "/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.facilitatorAuthHeader ?? {}),
      },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error("x402_verify_failed", { status: res.status, body: text.slice(0, 200) });
      return { ok: false, error: `facilitator /verify ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as FacilitatorVerifyResponse;
    if (!json.isValid) {
      return { ok: false, error: json.invalidReason ?? "facilitator rejected signature" };
    }
    log.info("x402_verified", {
      payer: json.payer,
      network: paymentRequirements.network,
      amount: paymentRequirements.amount,
    });
    return {
      ok: true,
      payer: json.payer,
      paymentPayload,
    };
  } catch (e) {
    log.error("x402_verify_error", { error: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Settle a verified payment. Called after the op succeeds.
 *
 * Pass the same `paymentPayload` and `paymentRequirements` used in verify.
 * The facilitator settles on-chain (Base: EIP-3009 transfer; Solana: signed
 * SPL transfer) and returns the tx hash.
 */
export async function settleX402(
  facilitatorUrl: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  opts: { facilitatorAuthHeader?: Record<string, string> } = {},
): Promise<X402SettleResult> {
  try {
    const res = await fetch(facilitatorUrl.replace(/\/$/, "") + "/settle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.facilitatorAuthHeader ?? {}),
      },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error("x402_settle_failed", { status: res.status, body: text.slice(0, 200) });
      return { ok: false, error: `facilitator /settle ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as FacilitatorSettleResponse;
    if (!json.success) {
      return { ok: false, error: json.errorReason ?? "facilitator did not settle" };
    }
    log.info("x402_settled", {
      transaction: json.transaction,
      network: json.network,
      amount: json.amount,
      payer: json.payer,
    });
    return {
      ok: true,
      transaction: json.transaction,
      network: json.network,
      amount: json.amount,
    };
  } catch (e) {
    log.error("x402_settle_error", { error: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Decode a `PAYMENT-SIGNATURE` header value (base64 JSON) into a
 * PaymentPayload. Throws on malformed input.
 */
export function decodePaymentPayload(headerValue: string): PaymentPayload {
  // Handle both base64 and base64url (some clients use one, some the other).
  const normalized = headerValue.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch (e) {
    throw new Error(`base64 decode failed: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("payload is not an object");
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.x402Version !== "number") {
    throw new Error("missing or invalid x402Version");
  }
  if (!p.accepted || typeof p.accepted !== "object") {
    throw new Error("missing accepted PaymentRequirements");
  }
  if (!p.payload || typeof p.payload !== "object") {
    throw new Error("missing payload");
  }
  return parsed as PaymentPayload;
}
