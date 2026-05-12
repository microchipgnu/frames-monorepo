// `curate` op — the full agent loop.
//
//   1. Load frame meta + schema + readme + customer prompt.md (if present)
//   2. Build system prompt
//   3. Loop:
//      a. LLM call with current message history + tools
//      b. For each tool_use block, dispatch and append tool_result
//      c. Decrement budget by LLM cost + tool cost
//      d. Halt when stop_reason=end_turn OR budget exhausted OR max_iters hit
//   4. Return events + tool_log + summary
//
// Frame events written via the write tools go into the response so the
// customer's CI can append them to events.ndjson. `tool.invoked` events for
// paid web_fetch calls are also included for the audit trail.

import { randomUUID } from "node:crypto";
import type { FrameEvent, ToolCall } from "@frames-ag/tick-types";
import { CatalogClient } from "../catalog/client";
import { FrameClient, type FrameMeta, type FrameSchema } from "../frame-client";
import { LlmClient, type LlmContent, type LlmMessage } from "../llm/client";
import { buildCurateSystem } from "../llm/system";
import { CURATE_TOOLS } from "../llm/tools";
import {
  dispatchCatalogGet,
  dispatchCatalogSearch,
  dispatchToolInvoke,
} from "./catalog-dispatch";
import type { OpOutcome, Refetcher, ToolDispatchResult } from "./types";

export interface CurateOptions {
  frame_url: string;
  budget: string;
  run_id: string;
  agent: string; // "frames-runtime:<wallet>"
  refetcher: Refetcher;
  client?: FrameClient;
  catalog?: CatalogClient;
  llm: LlmClient;
  /** Hard cap on agent-loop iterations. Defense against infinite tool loops. Default 30. */
  max_iters?: number;
  /** Halt new tool calls when remaining < safetyFloor (USDC). Default 0.05. */
  safety_floor?: string;
  /** Worker env, used by dispatch to lazy-load AUDIT_PRIVATE_KEY for receipt signing. */
  env?: { AUDIT_PRIVATE_KEY?: string };
  /**
   * Optional callback fired the moment a frame event lands. Used by the SSE
   * response path to emit events progressively instead of buffering to the
   * end. Synchronous; throwing inside the callback is the caller's problem.
   */
  onEvent?: (event: FrameEvent) => void;
  /**
   * Optional customer-supplied prompt (text). Appended to the system prompt
   * via `buildCurateSystem`. Typically the contents of `<dataset>/prompt.md`,
   * passed by the CLI's auto-discovery or `--prompt-file` flag.
   */
  custom_prompt?: string;
}

export async function curate(opts: CurateOptions): Promise<OpOutcome> {
  const client = opts.client ?? new FrameClient();
  const catalog = opts.catalog ?? new CatalogClient();
  const maxIters = opts.max_iters ?? 30;
  const safetyFloor = Number(opts.safety_floor ?? "0.05");
  let remaining = Number(opts.budget);

  // ----- Phase 1: load context -------------------------------------------
  const meta: FrameMeta = await client.getMeta(opts.frame_url);
  const schema: FrameSchema = await client.getSchema(opts.frame_url);
  let readme: string | undefined;
  try {
    readme = await client.getReadme(opts.frame_url);
  } catch {
    // README is optional
  }
  // Customer prompt: the CLI auto-discovers `<dataset>/prompt.md` locally and
  // POSTs it as `params.customer_prompt`; `app.ts` forwards it to `opts.custom_prompt`.
  // No frames-cloud resource needed — the prompt rides on the request body.

  const system = buildCurateSystem({
    meta,
    schema,
    readme,
    custom_prompt: opts.custom_prompt,
    budget: opts.budget,
  });

  // ----- Phase 2: agent loop ---------------------------------------------
  const messages: LlmMessage[] = [
    { role: "user", content: [{ type: "text", text: "Begin the curate tick." }] },
  ];

  const events: FrameEvent[] = [];
  const tool_log: ToolCall[] = [];

  let iter = 0;
  let stopReason: string = "max_iters";
  let summary = "(no summary)";

  while (iter < maxIters) {
    iter++;

    if (remaining < safetyFloor) {
      // Force-finalize: ask the model for a one-paragraph wrap-up, no more tools.
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Budget remaining is $${remaining.toFixed(4)} (below safety floor $${safetyFloor}). Wrap up: emit a one-paragraph summary of what was accomplished. Do not call any more tools.`,
          },
        ],
      });
      const finalRes = await opts.llm.call({ system, messages, agent: "build" });
      remaining -= Number(finalRes.usage.estimated_cost);
      summary = extractText(finalRes.content) || "(budget exhausted; no final summary)";
      stopReason = "budget_exhausted";
      break;
    }

    const llmRes = await opts.llm.call({
      system,
      messages,
      tools: CURATE_TOOLS,
      agent: "build",
    });
    remaining -= Number(llmRes.usage.estimated_cost);

    // Append the assistant's full content (text + tool_use) to messages so the
    // model sees its own prior turns.
    messages.push({ role: "assistant", content: llmRes.content });

    if (llmRes.stop_reason === "end_turn") {
      summary = extractText(llmRes.content) || "(no summary)";
      stopReason = "end_turn";
      break;
    }

    if (llmRes.stop_reason === "max_tokens") {
      summary = extractText(llmRes.content) + "\n\n[truncated: max_tokens]";
      stopReason = "max_tokens";
      break;
    }

    if (llmRes.stop_reason !== "tool_use") {
      // Unrecognized stop reason — bail rather than loop forever.
      summary = `unexpected stop_reason: ${llmRes.stop_reason}`;
      stopReason = llmRes.stop_reason;
      break;
    }

    // Dispatch every tool_use in the response.
    const toolResults: LlmContent[] = [];
    for (const block of llmRes.content) {
      if (block.type !== "tool_use") continue;
      const dispatch = await dispatchTool(block.name, block.input, {
        run_id: opts.run_id,
        agent: opts.agent,
        frame_client: client,
        frame_url: opts.frame_url,
        refetcher: opts.refetcher,
        catalog,
        remaining_budget: remaining.toFixed(6),
        env: opts.env,
      });
      remaining -= Number(dispatch.cost);
      for (const ev of dispatch.events) {
        events.push(ev);
        opts.onEvent?.(ev);
      }
      if (dispatch.tool_call) tool_log.push(dispatch.tool_call);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: dispatch.result_text,
        is_error: dispatch.is_error,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    events,
    tool_log,
    summary: `curate · ${schema.name}@${meta.sha.slice(0, 7)} · ${iter} iter · ${events.length} events · ${tool_log.length} tool calls · stop=${stopReason} · $${remaining.toFixed(6)} remaining`,
    report: {
      schema_name: schema.name,
      sha: meta.sha,
      iterations: iter,
      stop_reason: stopReason,
      events_written: events.length,
      tool_calls: tool_log.length,
      budget_remaining: remaining.toFixed(6),
      llm_summary: summary,
    },
  };
}

interface DispatchContext {
  run_id: string;
  agent: string;
  frame_client: FrameClient;
  frame_url: string;
  refetcher: Refetcher;
  catalog: CatalogClient;
  remaining_budget: string;
  env?: { AUDIT_PRIVATE_KEY?: string };
}

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolDispatchResult> {
  switch (name) {
    case "query":
      return await dispatchQuery(input, ctx);
    case "add_entity_with_facts":
      return dispatchAddEntityWithFacts(input, ctx);
    case "set_facts":
      return dispatchSetFacts(input, ctx);
    case "deprecate_fact":
      return dispatchDeprecateFact(input, ctx);
    case "attach_evidence":
      return dispatchAttachEvidence(input, ctx);
    case "web_fetch":
      return await dispatchWebFetch(input, ctx);
    case "catalog_search":
      return await dispatchCatalogSearch(input, ctx);
    case "catalog_get":
      return await dispatchCatalogGet(input, ctx);
    case "tool_invoke":
      return await dispatchToolInvoke(input, ctx);
    default:
      return {
        result_text: `Unknown tool: ${name}`,
        is_error: true,
        cost: "0",
        events: [],
      };
  }
}

async function dispatchQuery(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolDispatchResult> {
  const mode = String(input.mode);
  try {
    if (mode === "all") {
      const all: unknown[] = [];
      for await (const ent of ctx.frame_client.iterateEntities(ctx.frame_url, { include: "first" })) {
        all.push(ent);
      }
      return jsonResult(all);
    }
    if (mode === "entity") {
      const ent = await ctx.frame_client.getEntity(ctx.frame_url, String(input.entity_id), "all");
      return jsonResult(ent ?? { error: "not_found" });
    }
    if (mode === "field") {
      const all: unknown[] = [];
      for await (const ent of ctx.frame_client.iterateEntities(ctx.frame_url, { include: "all" })) {
        const val = ent.fields[String(input.field)];
        if (input.value === undefined || val === input.value) all.push(ent);
      }
      return jsonResult(all);
    }
    return errorResult(`unknown mode: ${mode}`);
  } catch (e) {
    return errorResult(`query failed: ${(e as Error).message}`);
  }
}

function dispatchAddEntityWithFacts(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): ToolDispatchResult {
  const entity_id = String(input.entity_id);
  const facts = (input.facts as Array<Record<string, unknown>>) ?? [];
  if (!entity_id || facts.length === 0) {
    return errorResult("entity_id + non-empty facts required");
  }
  const ts = new Date().toISOString();
  const events: FrameEvent[] = [];

  // 1. entity.created
  events.push({
    id: randomUUID(),
    ts,
    type: "entity.created",
    agent: ctx.agent,
    run_id: ctx.run_id,
    payload: { entity_id },
  });

  // 2. facts.set_many (v0.2.0 bulk event)
  events.push({
    id: randomUUID(),
    ts,
    type: "facts.set_many",
    agent: ctx.agent,
    run_id: ctx.run_id,
    payload: {
      entity_id,
      facts: facts.map((f) => ({
        fact_id: randomUUID(),
        field: String(f.field),
        value: f.value,
        source: f.source,
        ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        ...(f.observed_at !== undefined ? { observed_at: f.observed_at } : {}),
      })),
    },
  });

  return {
    result_text: `Created entity ${entity_id} with ${facts.length} facts.`,
    is_error: false,
    cost: "0",
    events,
  };
}

function dispatchSetFacts(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): ToolDispatchResult {
  const entity_id = String(input.entity_id);
  const facts = (input.facts as Array<Record<string, unknown>>) ?? [];
  if (!entity_id || facts.length === 0) {
    return errorResult("entity_id + non-empty facts required");
  }
  const event: FrameEvent = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "facts.set_many",
    agent: ctx.agent,
    run_id: ctx.run_id,
    payload: {
      entity_id,
      facts: facts.map((f) => ({
        fact_id: randomUUID(),
        field: String(f.field),
        value: f.value,
        source: f.source,
        ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        ...(f.observed_at !== undefined ? { observed_at: f.observed_at } : {}),
      })),
    },
  };
  return {
    result_text: `Set ${facts.length} facts on ${entity_id}.`,
    is_error: false,
    cost: "0",
    events: [event],
  };
}

function dispatchDeprecateFact(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): ToolDispatchResult {
  const fact_id = String(input.fact_id);
  const reason = String(input.reason);
  if (!fact_id || !reason) return errorResult("fact_id and reason required");
  return {
    result_text: `Deprecated fact ${fact_id}: ${reason}`,
    is_error: false,
    cost: "0",
    events: [
      {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: "fact.deprecated",
        agent: ctx.agent,
        run_id: ctx.run_id,
        payload: { fact_id, reason },
      },
    ],
  };
}

function dispatchAttachEvidence(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): ToolDispatchResult {
  const fact_id = String(input.fact_id);
  const source = input.source;
  if (!fact_id || !source) return errorResult("fact_id and source required");
  return {
    result_text: `Attached evidence to ${fact_id}`,
    is_error: false,
    cost: "0",
    events: [
      {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: "evidence.attached",
        agent: ctx.agent,
        run_id: ctx.run_id,
        payload: { fact_id, source },
      },
    ],
  };
}

async function dispatchWebFetch(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolDispatchResult> {
  const url = String(input.url);
  if (!url || !/^https?:\/\//.test(url)) return errorResult("valid http(s) url required");
  const result = await ctx.refetcher({
    url,
    remaining_budget: ctx.remaining_budget,
    run_id: ctx.run_id,
  });
  const cost = result.tool_call?.cost ?? "0";
  // Cap body to 64 KB in the tool_result to keep LLM context bounded.
  const body = (result.body ?? "").slice(0, 64 * 1024);
  const result_text = result.ok
    ? `Fetched ${result.final_url} (${result.body_bytes ?? body.length} bytes, $${cost}):\n\n${body}`
    : `Fetch failed: ${result.error}`;
  return {
    result_text,
    is_error: !result.ok,
    cost,
    events: result.event ? [result.event] : [],
    tool_call: result.tool_call,
  };
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

function extractText(content: LlmContent[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
