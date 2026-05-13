// Shared dispatch for the catalog-mediated discovery tools.
//
// Both curate and discover expose `catalog_search`, `catalog_get`, and
// `tool_invoke` to the LLM. The implementation is the same — extracted here
// so neither op duplicates ~150 lines of catalog plumbing.

import { randomUUID } from "node:crypto";
import type { FrameEvent } from "@frames-ag/tick-types";
import type { CatalogClient } from "../catalog/client";
import { signReceipt } from "../payment/audit-signer";
import { sha256 } from "../util/hash";
import { parseProbeResponse } from "../util/probe-parse";
import type { Refetcher, ToolDispatchResult } from "./types";

export interface CatalogDispatchContext {
  catalog: CatalogClient;
  refetcher: Refetcher;
  run_id: string;
  remaining_budget: string;
  /**
   * Agent identifier (`frames-runtime:<wallet>` or `frames-runtime:ip:<hash>`).
   * Stamped on every emitted frame event (tool.invoked) so audit dumps can
   * filter by who initiated the paid call.
   */
  agent: string;
  /**
   * Worker env — used to lazy-load the AUDIT_PRIVATE_KEY for signing receipts.
   * Optional: when undefined, receipts carry `signature: ""` (dev mode).
   */
  env?: { AUDIT_PRIVATE_KEY?: string };
}

export async function dispatchCatalogSearch(
  input: Record<string, unknown>,
  ctx: CatalogDispatchContext,
): Promise<ToolDispatchResult> {
  try {
    const limit = typeof input.limit === "number" ? Math.min(50, Math.max(1, input.limit)) : 10;
    const capability = typeof input.capability === "string" ? input.capability : undefined;
    const page = await ctx.catalog.search({ capability, limit });
    // Trim to fields the agent needs to pick a tool — keeps the tool_result
    // token-efficient. Full descriptors come on demand via catalog_get.
    const slim = page.tools.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      capabilities: t.capabilities,
      payment: {
        protocol: t.payment.protocol,
        network: t.payment.network,
        currency: t.payment.currency,
        price_hint: t.payment.price_hint,
      },
    }));
    return jsonResult({ count: slim.length, tools: slim, has_more: !!page.cursor });
  } catch (e) {
    return errorResult(`catalog_search failed: ${(e as Error).message}`);
  }
}

export async function dispatchCatalogGet(
  input: Record<string, unknown>,
  ctx: CatalogDispatchContext,
): Promise<ToolDispatchResult> {
  const id = typeof input.id === "string" ? input.id : "";
  if (!id) return errorResult("id required");
  try {
    const t = await ctx.catalog.get(id);
    if (!t) return errorResult(`descriptor not found: ${id}`);
    return jsonResult(t);
  } catch (e) {
    return errorResult(`catalog_get failed: ${(e as Error).message}`);
  }
}

export async function dispatchToolInvoke(
  input: Record<string, unknown>,
  ctx: CatalogDispatchContext,
): Promise<ToolDispatchResult> {
  const id = typeof input.id === "string" ? input.id : "";
  const args = (input.args as Record<string, unknown>) ?? {};
  if (!id) return errorResult("id required");

  try {
    const inv = await ctx.catalog.buildInvocation(id, args);
    if (!inv) return errorResult(`descriptor not found: ${id}`);

    // Pre-check budget vs price_hint (advisory; seller's 402 is authoritative).
    const hint = inv.price_hint ? Number(inv.price_hint) : 0;
    const remaining = Number(ctx.remaining_budget);
    if (hint > 0 && hint > remaining) {
      return errorResult(
        `tool_invoke aborted: price_hint $${hint} exceeds remaining budget $${remaining.toFixed(6)}. Use a cheaper tool or stop.`,
      );
    }

    if (inv.method === "GET") {
      // Route through the refetcher so paid/free selection lives in one place.
      const r = await ctx.refetcher({
        url: inv.url,
        remaining_budget: ctx.remaining_budget,
        run_id: ctx.run_id,
      });
      const body = (r.body ?? "").slice(0, 64 * 1024);
      const cost = r.tool_call?.cost ?? "0";
      const descriptor_id = inv.descriptor._descriptor_id ?? id;
      if (!r.ok) {
        const probe = buildProbeEvent({
          ctx,
          tool_id: id,
          descriptor_id,
          args,
          status: r.status,
          error: r.error,
          error_body: r.error_body,
        });
        return {
          result_text: probe.result_text,
          is_error: true,
          cost,
          events: r.event ? [r.event, probe.event] : [probe.event],
          tool_call: r.tool_call ? { ...r.tool_call, descriptor_id, tool_id: id } : undefined,
        };
      }
      // Mint a tool.invoked event so the agent can cite this paid call as
      // a source.receipt_id when writing facts. Minimal-shape receipt
      // (week-2 scope); full pay-spec ToolInvokedReceipt (signature, etc.)
      // ships when pay.Wallet integration lands.
      const ts = new Date().toISOString();
      const receiptUnsigned = {
        pay_protocol: "0.0.1",
        id: randomUUID(),
        ts,
        tool_id: id,
        descriptor_id,
        params_hash: await sha256(JSON.stringify(args)),
        protocol: inv.descriptor.payment.protocol,
        wallet_id: "tick",
        wallet_address: "(self-custody)",
        amount: cost,
        currency: inv.descriptor.payment.currency ?? "USDC",
        network: inv.descriptor.payment.network ?? "unknown",
        agent: ctx.agent,
      };
      const signature = await signReceipt(receiptUnsigned, ctx.env ?? {});
      const toolInvokedEvent: FrameEvent = {
        id: randomUUID(),
        ts,
        type: "tool.invoked",
        agent: ctx.agent,
        run_id: ctx.run_id,
        payload: {
          receipt: { ...receiptUnsigned, signature },
          tool: {
            params: args,
            response_excerpt: body.slice(0, 1024),
            response_size_bytes: r.body_bytes ?? body.length,
            response_truncated: body.length < (r.body_bytes ?? 0),
          },
        },
      };
      return {
        result_text: `tool_invoke(${id}) ok ($${cost}, ${body.length} bytes, receipt_id=${toolInvokedEvent.id}):\n\n${body}\n\n[Cite receipt_id=${toolInvokedEvent.id} on the source field of any fact derived from this response.]`,
        is_error: false,
        cost,
        events: r.event ? [r.event, toolInvokedEvent] : [toolInvokedEvent],
        tool_call: r.tool_call ? { ...r.tool_call, descriptor_id, tool_id: id } : undefined,
      };
    }

    // POST / PUT / etc — direct fetch (the refetcher is GET-only).
    // TODO week-4: route through a paid POST wrapper too.
    const res = await fetch(inv.url, {
      method: inv.method,
      headers: inv.headers,
      body: inv.body,
    });
    const cost =
      res.headers.get("X-PAYMENT-RESPONSE-AMOUNT") ??
      res.headers.get("X-PAYMENT-AMOUNT") ??
      "0";
    const text = await res.text();
    if (!res.ok) {
      const descriptor_id = inv.descriptor._descriptor_id ?? id;
      const probe = buildProbeEvent({
        ctx,
        tool_id: id,
        descriptor_id,
        args,
        status: res.status,
        error: `HTTP ${res.status}`,
        error_body: text,
      });
      return {
        result_text: probe.result_text,
        is_error: true,
        cost,
        events: [probe.event],
      };
    }
    const ts = new Date().toISOString();
    const descriptor_id = inv.descriptor._descriptor_id ?? id;
    const receiptUnsigned = {
      pay_protocol: "0.0.1",
      id: randomUUID(),
      ts,
      tool_id: id,
      descriptor_id,
      params_hash: await sha256(JSON.stringify(args)),
      protocol: inv.descriptor.payment.protocol,
      wallet_id: "tick",
      wallet_address: "(self-custody)",
      amount: cost,
      currency: inv.descriptor.payment.currency ?? "USDC",
      network: inv.descriptor.payment.network ?? "unknown",
      agent: ctx.agent,
    };
    const signature = await signReceipt(receiptUnsigned, ctx.env ?? {});
    const toolInvokedEvent: FrameEvent = {
      id: randomUUID(),
      ts,
      type: "tool.invoked",
      agent: ctx.agent,
      run_id: ctx.run_id,
      payload: {
        receipt: { ...receiptUnsigned, signature },
        tool: {
          params: args,
          response_excerpt: text.slice(0, 1024),
          response_size_bytes: text.length,
        },
      },
    };
    return {
      result_text: `tool_invoke(${id}) ok ($${cost}, ${text.length} bytes, receipt_id=${toolInvokedEvent.id}):\n\n${text.slice(0, 64 * 1024)}\n\n[Cite receipt_id=${toolInvokedEvent.id} on the source field of any fact derived from this response.]`,
      is_error: false,
      cost,
      events: [toolInvokedEvent],
      tool_call: {
        descriptor_id,
        tool_id: id,
        cost,
        source_url: inv.url,
        retrieved_at: ts,
        input_hash: await sha256(JSON.stringify(args)),
      },
    };
  } catch (e) {
    return errorResult(`tool_invoke failed: ${(e as Error).message}`);
  }
}

function jsonResult(value: unknown): ToolDispatchResult {
  return {
    result_text: JSON.stringify(value, null, 2),
    is_error: false,
    cost: "0",
    events: [],
  };
}

function errorResult(msg: string): ToolDispatchResult {
  return { result_text: msg, is_error: true, cost: "0", events: [] };
}

/**
 * Build a catalog.probe FrameEvent + the matching result_text shown to the LLM.
 *
 * Called from both the GET and POST failure paths in dispatchToolInvoke. The
 * event records every attempt — args, status, parsed hints — so analytics can
 * later answer "which catalog entries fail and why" without re-running probes.
 *
 * The result_text is designed for the LLM: a one-line summary + the structured
 * hints (so a retry with corrected args is possible) + the raw response excerpt
 * as a last-resort context. Capped so it doesn't eat the agent's token budget.
 */
function buildProbeEvent(args: {
  ctx: CatalogDispatchContext;
  tool_id: string;
  descriptor_id: string;
  args: Record<string, unknown>;
  status?: number;
  error?: string;
  error_body?: string;
}): { event: FrameEvent; result_text: string } {
  const status = args.status ?? 0;
  const body = (args.error_body ?? "").slice(0, 4 * 1024);
  const parsed = status > 0
    ? parseProbeResponse(status, body)
    : { hints: [{ kind: "unknown" as const, message: args.error ?? "fetch failed" }], summary: args.error ?? "fetch failed", retryable: false };

  const event: FrameEvent = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "catalog.probe",
    agent: args.ctx.agent,
    run_id: args.ctx.run_id,
    payload: {
      tool_id: args.tool_id,
      descriptor_id: args.descriptor_id,
      args: args.args,
      status,
      hints: parsed.hints,
      summary: parsed.summary,
      response_excerpt: body.slice(0, 1024),
      retryable: parsed.retryable,
    },
  };

  const hintLines = parsed.hints
    .map((h) => `  - [${h.kind}]${h.field ? ` field=${h.field}` : ""}: ${h.message}`)
    .join("\n");
  const retryLine = parsed.retryable
    ? `Retry tool_invoke(${args.tool_id}) once with corrected args. If it fails again, fall back to web_fetch.`
    : `Do NOT retry tool_invoke(${args.tool_id}); pick another descriptor or fall back to web_fetch.`;

  const result_text = [
    `tool_invoke(${args.tool_id}) failed: ${parsed.summary}`,
    "",
    "Parsed hints:",
    hintLines,
    "",
    retryLine,
    body ? `\nResponse excerpt:\n${body.slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { event, result_text };
}

