// Default refetcher: plain HTTPS fetch with a timeout. Free for public URLs.
//
// Week 2 ships a pay.Wallet-backed refetcher for paid catalog endpoints that
// require x402 payment to access. The shape (Refetcher) is identical so call
// sites are unchanged — pick the implementation via DI at op dispatch time.
//
// This stub:
//   - GET only, no credentials
//   - 10s timeout
//   - Follows redirects (returns final_url)
//   - Records a $0 tool_call entry per fetch for audit; no tool.invoked event
//     since no paid call took place

import type { ToolCall } from "@frames-ag/tick-types";
import { fastNonCryptoHash } from "../util/hash";
import type { Refetcher, RefetchResult } from "./types";

export interface HttpRefetcherOptions {
  timeout_ms?: number;
  /** Max body size to retain in memory. Larger bodies are truncated. Default 2 MiB. */
  max_body_bytes?: number;
  user_agent?: string;
}

export function createHttpRefetcher(opts: HttpRefetcherOptions = {}): Refetcher {
  const timeoutMs = opts.timeout_ms ?? 10_000;
  const maxBytes = opts.max_body_bytes ?? 2 * 1024 * 1024;
  const ua = opts.user_agent ?? "tick/0.0.0 (+https://tick.frames.ag)";

  return async ({ url }): Promise<RefetchResult> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": ua, accept: "*/*" },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return {
        ok: false,
        final_url: url,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        tool_call: makeFreeToolCall(url, "0", started, undefined, e instanceof Error ? e.message : String(e)),
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
        tool_call: makeFreeToolCall(url, "0", started, undefined, `HTTP ${res.status}`),
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
      tool_call: makeFreeToolCall(url, "0", started, bodyBytes),
    };
  };
}

function makeFreeToolCall(
  url: string,
  cost: string,
  started: number,
  bytes?: number,
  _error?: string,
): ToolCall {
  return {
    descriptor_id: "tick:http-refetcher", // not a real catalog descriptor; placeholder
    tool_id: "tick.http.fetch",
    cost,
    source_url: url,
    retrieved_at: new Date().toISOString(),
    input_hash: fastNonCryptoHash(url),
  };
  void started;
  void bytes;
  void _error;
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
