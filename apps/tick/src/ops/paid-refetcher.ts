// Paid Refetcher — uses @faremeter/fetch's wrap() under the hood.
//
// Same shape as the free `httpRefetcher` but every fetch goes through the
// paidFetch produced by `bootWallets`. On 402, wrap() picks the right
// handler (x402 v1/v2 on Solana/Base, MPP on Solana/Tempo) and resubmits.
//
// Cost is read from the response's `X-PAYMENT-RESPONSE-*` headers (set by
// the seller after settlement). The `tool_call` returned mirrors the same
// shape as httpRefetcher's so the rest of the pipeline (verify op, D1
// inserts, receipts) doesn't need to know which refetcher produced it.

import type { ToolCall } from "@frames-ag/tick-types";
import { fastNonCryptoHash } from "../util/hash";
import type { Refetcher, RefetchResult } from "./types";

export interface PaidRefetcherOptions {
  paidFetch: typeof fetch;
  timeout_ms?: number;
  max_body_bytes?: number;
  user_agent?: string;
  /**
   * When set, paidFetch is only used for URLs matching this predicate; other
   * URLs fall through to the underlying global fetch with no payment wrap.
   * Default: route everything through paidFetch (let wrap() decide whether to
   * pay based on the 402 response).
   */
  shouldPay?: (url: string) => boolean;
}

export function createPaidRefetcher(opts: PaidRefetcherOptions): Refetcher {
  const timeoutMs = opts.timeout_ms ?? 30_000;        // longer than free: paid 402 dance can take seconds
  const maxBytes = opts.max_body_bytes ?? 2 * 1024 * 1024;
  const ua = opts.user_agent ?? "tick/0.0.0 (+https://tick.frames.ag)";
  const shouldPay = opts.shouldPay ?? (() => true);
  const paidFetch = opts.paidFetch;

  return async ({ url }): Promise<RefetchResult> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchFn = shouldPay(url) ? paidFetch : fetch;

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": ua, accept: "*/*" },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return {
        ok: false,
        final_url: url,
        error: message,
        tool_call: makeToolCall(url, "0", started, undefined, message),
      };
    }
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await readBodyCapped(res, maxBytes);
      return {
        ok: false,
        final_url: res.url,
        status: res.status,
        error: `HTTP ${res.status}`,
        error_body: errBody,
        tool_call: makeToolCall(url, costFromHeaders(res), started, undefined, `HTTP ${res.status}`),
      };
    }

    // Read with byte cap
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received <= maxBytes) chunks.push(value);
        }
      }
    }

    const truncated = received > maxBytes;
    const bodyBytes = truncated ? maxBytes : received;
    const text = new TextDecoder("utf-8").decode(concat(chunks));

    return {
      ok: true,
      final_url: res.url,
      body: text,
      body_bytes: bodyBytes,
      tool_call: makeToolCall(url, costFromHeaders(res), started, bodyBytes),
    };
  };
}

/**
 * Extract settled cost from response headers set by the x402 / MPP seller.
 * Header conventions per the protocol specs:
 *   - x402 v2: `X-PAYMENT-RESPONSE-AMOUNT` (USDC string)
 *   - x402 v1: `X-PAYMENT-AMOUNT` (USDC string)
 *   - MPP:     `Payment-Response` value carries the credential; settled
 *              amount is in the credential's payload.amount field (parsed
 *              by the wrap() retry path; we surface it here as best-effort)
 *
 * Returns "0" when no cost header is present (free or non-paid fetch).
 */
function costFromHeaders(res: Response): string {
  return (
    res.headers.get("X-PAYMENT-RESPONSE-AMOUNT") ??
    res.headers.get("X-PAYMENT-AMOUNT") ??
    res.headers.get("Payment-Response-Amount") ??
    "0"
  );
}

function makeToolCall(
  url: string,
  cost: string,
  _started: number,
  _bytes?: number,
  _error?: string,
): ToolCall {
  return {
    descriptor_id: "tick:paid-refetcher", // catalog-resolved descriptor flow comes when the agent loop dispatches via catalog.search → tool.invoke
    tool_id: "tick.paid.fetch",
    cost,
    source_url: url,
    retrieved_at: new Date().toISOString(),
    input_hash: fastNonCryptoHash(url),
  };
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received <= maxBytes) chunks.push(value);
      }
    }
  }
  return new TextDecoder("utf-8").decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
