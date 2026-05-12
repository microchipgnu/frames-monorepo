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
import { summarizeForContext } from "../llm/summarize";
import { buildCurateSystem } from "../llm/system";
import { CURATE_TOOLS } from "../llm/tools";
import { refreshEntity } from "./refresh-entity";
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
  // Per-iter LLM-call log so customers can see where their budget went.
  const iteration_log: import("@frames-ag/tick-types").IterationLogEntry[] = [];
  // Sub-agent runs (one per refresh_entity tool call). Each is its own
  // bounded loop with its own iteration_log + tool_log. Surfaced on the
  // run record so the customer can see what each entity sub-loop did.
  const sub_runs: import("./types").SubRun[] = [];

  let iter = 0;
  let stopReason: string = "max_iters";
  let summary = "(no summary)";
  // Track LLM cost separately so the next-iter projection is honest. A run
  // that explores cheaply via free tool calls can still blow its budget on
  // Claude tokens — those compound iteration-over-iteration as the context
  // grows. Project the next iter as 1.2× the most expensive prior LLM call.
  let maxLlmCostSeen = 0;

  while (iter < maxIters) {
    iter++;

    // Project the next iter's likely LLM cost and halt early when it would
    // push remaining below the floor. Without this, the agent can run a full
    // iteration into a budget shortfall, post-hoc detect "remaining < floor",
    // then spend ANOTHER call asking for a summary — overrunning by 2×.
    const projectedLlmCost = maxLlmCostSeen > 0 ? maxLlmCostSeen * 1.2 : 0;
    if (remaining < safetyFloor || (projectedLlmCost > 0 && remaining < projectedLlmCost + safetyFloor)) {
      // Force-finalize: ask the model for a one-paragraph wrap-up, no more tools.
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Budget remaining is $${remaining.toFixed(4)} (next LLM call projects ~$${projectedLlmCost.toFixed(4)}, safety floor $${safetyFloor}). Wrap up: emit a one-paragraph summary of what was accomplished. Do not call any more tools.`,
          },
        ],
      });
      const finalRes = await opts.llm.call({ system, messages, agent: "build" });
      remaining -= Number(finalRes.usage.estimated_cost);
      summary = extractText(finalRes.content) || "(budget exhausted; no final summary)";
      stopReason = "budget_exhausted";
      iteration_log.push({
        iter,
        model: finalRes.model,
        input_tokens: finalRes.usage.input_tokens,
        output_tokens: finalRes.usage.output_tokens,
        cost: finalRes.usage.estimated_cost,
        stop_reason: "budget_exhausted",
        cache_creation_input_tokens: finalRes.usage.cache_creation_input_tokens,
        cache_read_input_tokens: finalRes.usage.cache_read_input_tokens,
      });
      break;
    }

    const llmRes = await opts.llm.call({
      system,
      messages,
      tools: CURATE_TOOLS,
      agent: "build",
    });
    const llmCost = Number(llmRes.usage.estimated_cost);
    remaining -= llmCost;
    if (llmCost > maxLlmCostSeen) maxLlmCostSeen = llmCost;
    iteration_log.push({
      iter,
      model: llmRes.model,
      input_tokens: llmRes.usage.input_tokens,
      output_tokens: llmRes.usage.output_tokens,
      cost: llmRes.usage.estimated_cost,
      stop_reason: llmRes.stop_reason,
      cache_creation_input_tokens: llmRes.usage.cache_creation_input_tokens,
      cache_read_input_tokens: llmRes.usage.cache_read_input_tokens,
    });

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
    //
    // Optimization: when every tool_use in the turn is a `refresh_entity`,
    // dispatch them concurrently via Promise.all so EntityAgent DOs run in
    // parallel isolates. Mixed-tool turns (refresh_entity + set_facts, etc.)
    // stay sequential because write ordering matters when tools mutate
    // shared parent state.
    const toolUseBlocks = llmRes.content.filter(
      (b): b is Extract<LlmContent, { type: "tool_use" }> => b.type === "tool_use",
    );
    const allRefresh = toolUseBlocks.length > 1 && toolUseBlocks.every((b) => b.name === "refresh_entity");

    const buildCtx = () => ({
      run_id: opts.run_id,
      agent: opts.agent,
      frame_client: client,
      frame_url: opts.frame_url,
      refetcher: opts.refetcher,
      catalog,
      remaining_budget: remaining.toFixed(6),
      env: opts.env,
      llm: opts.llm,
      schema,
    });

    const dispatches: ToolDispatchResult[] = allRefresh
      ? await Promise.all(toolUseBlocks.map((b) => dispatchTool(b.name, b.input, buildCtx())))
      : await (async () => {
          const out: ToolDispatchResult[] = [];
          for (const b of toolUseBlocks) {
            out.push(await dispatchTool(b.name, b.input, buildCtx()));
          }
          return out;
        })();

    const toolResults: LlmContent[] = [];
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const block = toolUseBlocks[i]!;
      const dispatch = dispatches[i]!;
      remaining -= Number(dispatch.cost);
      for (const ev of dispatch.events) {
        events.push(ev);
        opts.onEvent?.(ev);
      }
      if (dispatch.tool_call) tool_log.push(dispatch.tool_call);
      if (dispatch.sub_run) {
        sub_runs.push(dispatch.sub_run);
        for (const tc of dispatch.sub_run.tool_log) tool_log.push(tc);
      }
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
    summary: `curate · ${schema.name}@${meta.sha.slice(0, 7)} · ${iter} iter · ${sub_runs.length} sub-agents · ${events.length} events · ${tool_log.length} tool calls · stop=${stopReason} · $${remaining.toFixed(6)} remaining`,
    iteration_log,
    sub_runs,
    report: {
      schema_name: schema.name,
      sha: meta.sha,
      iterations: iter,
      stop_reason: stopReason,
      events_written: events.length,
      tool_calls: tool_log.length,
      sub_runs: sub_runs.length,
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
  env?: {
    AUDIT_PRIVATE_KEY?: string;
    /** When present, refresh_entity dispatches to this DO for isolated CPU. */
    ENTITY_AGENT?: DurableObjectNamespace<import("../agents/entity-agent").EntityAgent>;
  };
  /** LLM + schema needed for cheap-model summarization of fetched pages. */
  llm: LlmClient;
  schema: FrameSchema;
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
    case "refresh_entity":
      return await dispatchRefreshEntity(input, ctx);
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

async function dispatchRefreshEntity(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolDispatchResult> {
  const entity_id = String(input.entity_id ?? "");
  if (!entity_id) return errorResult("entity_id required");
  const focus = Array.isArray(input.focus) ? (input.focus as unknown[]).map(String) : undefined;

  // Load the entity's current state via frames-cloud so the sub-loop sees
  // facts + evidence + fact_ids in one shot. The sub-loop won't re-fetch this.
  let entity_state: Record<string, unknown> | null = null;
  try {
    entity_state = (await ctx.frame_client.getEntity(ctx.frame_url, entity_id, "all")) as Record<string, unknown> | null;
  } catch (e) {
    return errorResult(`failed to load entity_state for ${entity_id}: ${(e as Error).message}`);
  }
  if (!entity_state) {
    return errorResult(`entity_id ${entity_id} not found in dataset`);
  }

  // Route to the EntityAgent Durable Object when available (production CF
  // Workers). The DO runs in its own isolate with its own CPU budget, so
  // concurrent refresh_entity calls (within a single agent turn that emits
  // multiple tool_use blocks) actually parallelize. Falls back to the pure
  // function for local Bun dev / smoketest where no DO binding exists.
  const sub = ctx.env?.ENTITY_AGENT
    ? await ctx.env.ENTITY_AGENT.get(
        ctx.env.ENTITY_AGENT.idFromName(`${ctx.run_id}:${entity_id}`),
      ).refresh({
        entity_id,
        entity_state,
        schema: ctx.schema,
        focus,
        budget: "0.30",
        max_iters: 5,
        run_id: ctx.run_id,
        agent: ctx.agent,
      })
    : await refreshEntity({
        entity_id,
        entity_state,
        schema: ctx.schema,
        focus,
        llm: ctx.llm,
        refetcher: ctx.refetcher,
        budget: "0.30",
        max_iters: 5,
        run_id: ctx.run_id,
        agent: ctx.agent,
      });

  // Emit the sub-loop's writes as real frame events.
  const events: FrameEvent[] = [];
  const ts = new Date().toISOString();
  if (sub.facts_to_set.length > 0) {
    events.push({
      id: randomUUID(),
      ts,
      type: "facts.set_many",
      agent: ctx.agent,
      run_id: ctx.run_id,
      payload: {
        entity_id,
        facts: sub.facts_to_set.map((f) => ({
          fact_id: randomUUID(),
          field: f.field,
          value: f.value,
          source: f.source,
        })),
      },
    });
  }
  for (const dep of sub.facts_to_deprecate) {
    events.push({
      id: randomUUID(),
      ts,
      type: "fact.deprecated",
      agent: ctx.agent,
      run_id: ctx.run_id,
      payload: {
        fact_id: dep.fact_id,
        reason: dep.reason,
      },
    });
  }

  // Pass through the sub-loop's tool calls into the parent's tool_log via
  // the dispatch return. The parent's loop appends `tool_call` to tool_log;
  // we only get one slot, so use the first (sub_runs holds the rest in the
  // final RunResult.report).
  // The textual `result_text` returned to the LLM is a compact summary so
  // the parent's context stays small — full sub-loop details are persisted
  // separately on the run record.
  const action =
    sub.facts_to_set.length > 0 ? "facts_set" :
    sub.facts_to_deprecate.length > 0 ? "deprecated" :
    sub.stop_reason === "no_change" ? "no_change" : "no_op";

  const result_text = [
    `refresh_entity(${entity_id}) → ${action}`,
    `  stop_reason:   ${sub.stop_reason}`,
    `  facts set:     ${sub.facts_to_set.length}${sub.facts_to_set.length > 0 ? ` (${sub.facts_to_set.map((f) => f.field).join(", ")})` : ""}`,
    `  deprecations:  ${sub.facts_to_deprecate.length}`,
    `  llm_cost:      $${sub.llm_cost}`,
    `  iterations:    ${sub.iteration_log.length}`,
    "",
    `narrative: ${sub.narrative}`,
  ].join("\n");

  return {
    result_text,
    is_error: sub.stop_reason === "error",
    cost: sub.llm_cost,
    events,
    // Surface sub_run details on the return so curate.ts can append to a
    // top-level sub_runs array. The tool_call slot is used by paid catalog
    // tools (this is a sub-agent call, not a paid tool, so leave undefined).
    sub_run: {
      entity_id,
      action,
      stop_reason: sub.stop_reason,
      facts_set: sub.facts_to_set.length,
      deprecations: sub.facts_to_deprecate.length,
      iterations: sub.iteration_log.length,
      iteration_log: sub.iteration_log,
      tool_log: sub.tool_log,
      llm_cost: sub.llm_cost,
      narrative: sub.narrative,
    },
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
  const fetchCost = result.tool_call?.cost ?? "0";

  if (!result.ok) {
    return {
      result_text: `Fetch failed: ${result.error}`,
      is_error: true,
      cost: fetchCost,
      events: result.event ? [result.event] : [],
      tool_call: result.tool_call,
    };
  }

  // Summarize the fetched body via a cheap-model call BEFORE it lands in
  // the parent agent's context. This is the single biggest cost lever in
  // tick — see src/llm/summarize.ts header for the rationale. Raw HTML
  // would compound the parent's context by 30-80 KB per fetch; the summary
  // is ~500-2000 tokens of structured per-field excerpts.
  const summary = await summarizeForContext({
    body: result.body ?? "",
    schema: ctx.schema,
    entity_hint: typeof input.entity_hint === "string" ? input.entity_hint : undefined,
    source_url: url,
    final_url: result.final_url,
    llm: ctx.llm,
  });

  // Total cost = fetch cost (typically $0) + summarizer LLM cost.
  const totalCost = (Number(fetchCost) + Number(summary.cost)).toFixed(6);

  return {
    result_text: summary.summary,
    is_error: false,
    cost: totalCost,
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
