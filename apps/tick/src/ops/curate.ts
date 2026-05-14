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

import { createHash, randomUUID } from "node:crypto";
import type { FrameEvent, ToolCall } from "@frames-ag/tick-types";
import { CatalogClient } from "../catalog/client";
import { FrameClient, type FrameMeta, type FrameSchema } from "../frame-client";
import { LlmClient, type LlmContent, type LlmMessage } from "../llm/client";
import { summarizeForContext } from "../llm/summarize";
import { buildCurateSystem } from "../llm/system";
import { CURATE_TOOLS } from "../llm/tools";
import { refreshEntity } from "./refresh-entity";
import { discoverEntity } from "./discover-entity";
import { verifyCitations } from "./verify-citations";
import {
  dispatchCatalogGet,
  dispatchCatalogSearch,
  dispatchToolInvoke,
} from "./catalog-dispatch";
import type { OpOutcome, Refetcher, SubRun, ToolDispatchResult } from "./types";

export interface CurateOptions {
  frame_url: string;
  /**
   * Total budget (legacy). When set, split 80/20 into llm_budget / tool_budget
   * if those aren't explicitly provided. Kept for backward compat with the
   * `POST /run` body shape that ships before v0.5.x.
   */
  budget?: string;
  /**
   * v0.5.x — separate pot for LLM iterations and sub-agent LLM cost. The
   * agent stops when this hits zero, independently of `tool_budget`.
   * Defaults to 80% of `budget` when only `budget` is provided.
   */
  llm_budget?: string;
  /**
   * v0.5.x — separate pot for paid `tool_invoke` (and any paid web_fetch).
   * Reserved floor of spend the agent can use on the catalog before being
   * stopped. Without this split, LLM cost can devour the budget before the
   * agent ever calls a paid tool.
   * Defaults to 20% of `budget` when only `budget` is provided.
   */
  tool_budget?: string;
  run_id: string;
  agent: string; // "frames-runtime:<wallet>"
  refetcher: Refetcher;
  client?: FrameClient;
  catalog?: CatalogClient;
  /**
   * Drop-in `typeof fetch` that satisfies x402/MPP 402 challenges using the
   * booted outbound wallets. Threaded into `dispatchToolInvoke` for the POST
   * branch (GET goes through `refetcher`, which is already paidFetch-backed).
   * When unset, paid POSTs fall back to global fetch — 402s leak as
   * catalog.probe events instead of getting paid.
   */
  paidFetch?: typeof fetch;
  /**
   * Which payment chains have a booted wallet. Threaded into catalog dispatch
   * so `catalog_search` filters out descriptors the runtime can't pay.
   */
  walletCapability?: { evm: boolean; solana: boolean; tempo: boolean };
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
  /**
   * Phase E — CitationAgent. When true (default), every fact written during
   * this run gets a post-pass Haiku check that its cited excerpt directly
   * supports the value. Unsupported facts get a `fact.deprecated` event
   * appended with reason `citation_unverified: …`. Set false to skip
   * (e.g., bulk-import flows where you've already verified externally).
   */
  verify_citations?: boolean;
}

export async function curate(opts: CurateOptions): Promise<OpOutcome> {
  const client = opts.client ?? new FrameClient();
  const catalog = opts.catalog ?? new CatalogClient();
  const maxIters = opts.max_iters ?? 30;
  const safetyFloor = Number(opts.safety_floor ?? "0.05");

  // Budget split — two independent pots. Force-stop fires when EITHER hits
  // the safety floor. Without this split, LLM iter cost (~$1.36 of a $1.50
  // run, measured live 2026-05-13) drains the single pot before the agent
  // ever reaches a paid tool. Splitting reserves a guaranteed floor for
  // paid catalog calls so the runtime can actually validate end-to-end.
  //
  // Default split for legacy `budget`: 80% LLM / 20% tool. Tuned from
  // observed iteration_log breakdowns — LLM dominates, paid tools are
  // cents at most, but the ratio MUST guarantee some non-zero tool slack.
  const totalLegacyBudget = opts.budget ? Number(opts.budget) : undefined;
  let llmRemaining = Number(
    opts.llm_budget ??
      (totalLegacyBudget !== undefined ? (totalLegacyBudget * 0.8).toFixed(6) : "1.20"),
  );
  let toolRemaining = Number(
    opts.tool_budget ??
      (totalLegacyBudget !== undefined ? (totalLegacyBudget * 0.2).toFixed(6) : "0.30"),
  );

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
    llm_budget: llmRemaining.toFixed(6),
    tool_budget: toolRemaining.toFixed(6),
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
  // Phase E.2 + Phase F (Layer 1) — evidence-aware early stop.
  // Two independent triggers:
  //   (a) **Generous threshold** — 5 consecutive iters with no events
  //       emitted. Bumped from 3 in v0.2.0 because legitimate EXPAND-mode
  //       exploration can run 3-4 catalog/search iters before writing.
  //   (b) **Sharp spin detector** — if an iter's exact tool-call signature
  //       (sorted (name, input) hashes) matches the previous iter's AND
  //       both produced zero events, stop immediately. Repeating the
  //       SAME calls without progress is spinning regardless of streak.
  // (a) trips on slow exploration that never converges; (b) trips on
  // tight loops the moment they appear. Both are necessary.
  let parentNoProgressStreak = 0;
  let lastIterSignature = "";
  // Phase F (Layer 1.5) — track entity_ids that have a pending entity.created
  // event in this run. Parallel discover_entity sub-agents only see
  // known_entity_ids at dispatch time; two concurrent calls can therefore
  // both decide to add the same entity, producing duplicate entity.created
  // events. Live curate on 2026-05-13 reproduced this with `prefecthq-fastmcp`
  // appearing twice. Loser drops to entity_matched_existing posture in
  // sub_runs so customers can see the collision in the receipt.
  const addedEntityIds = new Set<string>();

  while (iter < maxIters) {
    iter++;

    // Project the next iter's likely LLM cost and halt early when the LLM
    // pot would drop below the floor. Without this, the agent can run a
    // full iteration into a budget shortfall, post-hoc detect remaining <
    // floor, then spend ANOTHER call asking for a summary — overrunning 2×.
    //
    // Tool budget intentionally NOT checked here: it's a discretionary pot
    // (only spent if the agent picks `tool_invoke`). Per-call exhaustion is
    // handled at dispatch time — catalog_dispatch refuses calls whose
    // price_hint exceeds tool_remaining. Force-stopping when tool_budget is
    // low would punish runs that haven't used paid tools yet.
    const projectedLlmCost = maxLlmCostSeen > 0 ? maxLlmCostSeen * 1.2 : 0;
    if (llmRemaining < safetyFloor || (projectedLlmCost > 0 && llmRemaining < projectedLlmCost + safetyFloor)) {
      // Force-finalize: ask the model for a one-paragraph wrap-up, no more tools.
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `LLM budget remaining $${llmRemaining.toFixed(4)} (next iter projects ~$${projectedLlmCost.toFixed(4)}, floor $${safetyFloor}). Wrap up: emit a one-paragraph summary of what was accomplished. Do not call any more tools.`,
          },
        ],
      });
      // v0.3.10 — wrap-up is one paragraph of summary prose. Haiku is the
      // right tier; Sonnet was costing ~$0.18 per wrap-up which alone
      // pushed budget-exhausted runs ~$0.02 negative against the cap.
      // Drop tools too — Haiku doesn't share Sonnet's cached prefix anyway
      // (different model tier = different cache), so keeping tools just
      // bloats the input without helping. v0.3.2's "preserve cache by
      // passing tools" reasoning applied to Sonnet, not to a tier switch.
      // Expected wrap-up cost: ~$0.005 vs ~$0.18 — eliminates the overrun.
      const finalRes = await opts.llm.call({ system, messages, agent: "title" });
      llmRemaining -= Number(finalRes.usage.estimated_cost);
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
        assistant_text: summary && summary !== "(no summary)" ? summary.slice(0, 240) : undefined,
      });
      break;
    }

    // Evidence-aware early stop. Different signal from the budget guard:
    // we have plenty of money left, but the model is searching without
    // writing. Either trigger fires → halt and force-summarize.
    if (parentNoProgressStreak >= 5) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Several consecutive iterations produced no events (no facts written, no entities added). You're either spinning on the same calls or exploring without converging. Either commit to writes via your sub-agents / direct write tools, or wrap up. Write a one-paragraph summary of what was accomplished and stop calling tools.",
          },
        ],
      });
      // v0.3.10 — same reasoning as the budget-exhausted wrap-up: Haiku
      // is the right tier for one-paragraph summary prose.
      const finalRes = await opts.llm.call({ system, messages, agent: "title" });
      llmRemaining -= Number(finalRes.usage.estimated_cost);
      summary = extractText(finalRes.content) || "(no summary — stopped on no-progress)";
      stopReason = "no_progress";
      iteration_log.push({
        iter,
        model: finalRes.model,
        input_tokens: finalRes.usage.input_tokens,
        output_tokens: finalRes.usage.output_tokens,
        cost: finalRes.usage.estimated_cost,
        stop_reason: "no_progress",
        cache_creation_input_tokens: finalRes.usage.cache_creation_input_tokens,
        cache_read_input_tokens: finalRes.usage.cache_read_input_tokens,
        assistant_text: summary && summary !== "(no summary — stopped on no-progress)" ? summary.slice(0, 240) : undefined,
      });
      break;
    }

    // max_tokens bumped 4096 → 8192 in v0.3.14. v0.3.13's structured-output
    // summarizer produces denser per-fetch results (field names + values +
    // excerpts + notes vs prior prose), and the model's response on
    // multi-tool-use turns (parallel sub-agent dispatches with arguments
    // each) can be sizeable. Live data 2026-05-13 caught a
    // stop_reason: max_tokens parent halt that wasn't happening before.
    // 8192 leaves room without being wasteful — typical turns produce
    // 200-1500 output tokens.
    const llmRes = await opts.llm.call({
      system,
      messages,
      tools: CURATE_TOOLS,
      agent: "build",
      max_tokens: 8192,
    });
    const llmCost = Number(llmRes.usage.estimated_cost);
    llmRemaining -= llmCost;
    if (llmCost > maxLlmCostSeen) maxLlmCostSeen = llmCost;
    const iterText = extractText(llmRes.content);
    iteration_log.push({
      iter,
      model: llmRes.model,
      input_tokens: llmRes.usage.input_tokens,
      output_tokens: llmRes.usage.output_tokens,
      cost: llmRes.usage.estimated_cost,
      stop_reason: llmRes.stop_reason,
      cache_creation_input_tokens: llmRes.usage.cache_creation_input_tokens,
      cache_read_input_tokens: llmRes.usage.cache_read_input_tokens,
      assistant_text: iterText.length > 0 ? iterText.slice(0, 240) : undefined,
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
    // Optimization: when every tool_use in the turn is a sub-agent call
    // (`refresh_entity` or `discover_entity` — both route through the
    // EntityAgent DO with no shared state), dispatch them concurrently via
    // Promise.all so DO isolates run truly in parallel. Mixed-tool turns
    // (refresh_entity + set_facts, etc.) stay sequential because write
    // ordering matters when tools mutate shared parent state.
    const toolUseBlocks = llmRes.content.filter(
      (b): b is Extract<LlmContent, { type: "tool_use" }> => b.type === "tool_use",
    );
    const allSubAgents =
      toolUseBlocks.length > 1 &&
      toolUseBlocks.every((b) => b.name === "refresh_entity" || b.name === "discover_entity");

    const buildCtx = () => ({
      run_id: opts.run_id,
      agent: opts.agent,
      frame_client: client,
      frame_url: opts.frame_url,
      refetcher: opts.refetcher,
      catalog,
      paidFetch: opts.paidFetch,
      walletCapability: opts.walletCapability,
      // Pass the tool pot to dispatchers — used by catalog_dispatch's
      // pre-flight price check (descriptor.price_hint vs remaining tool
      // budget). LLM-cost dispatchers (sub-agents, web_fetch summarizer)
      // are budget-aware separately when needed.
      remaining_budget: toolRemaining.toFixed(6),
      env: opts.env,
      llm: opts.llm,
      schema,
    });

    const dispatches: ToolDispatchResult[] = allSubAgents
      ? await Promise.all(toolUseBlocks.map((b) => dispatchTool(b.name, b.input, buildCtx())))
      : await (async () => {
          const out: ToolDispatchResult[] = [];
          for (const b of toolUseBlocks) {
            out.push(await dispatchTool(b.name, b.input, buildCtx()));
          }
          return out;
        })();

    const toolResults: LlmContent[] = [];
    let eventsEmittedThisIter = 0;
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const block = toolUseBlocks[i]!;
      const dispatch = dispatches[i]!;

      // Dedup entity.created across parallel sub-agents. Sub-agent receives
      // known_entity_ids at dispatch time; two concurrent discover_entity
      // calls can both decide to add the same entity. First wins. Loser is
      // logged in sub_runs with `entity_matched_existing` posture and its
      // events are dropped — keeps the receipt honest without writing
      // duplicates.
      let duplicateOf: string | undefined;
      for (const ev of dispatch.events) {
        if (ev.type === "entity.created") {
          const id = String((ev.payload as { entity_id?: string }).entity_id ?? "");
          if (id && addedEntityIds.has(id)) {
            duplicateOf = id;
            break;
          }
        }
      }
      if (duplicateOf) {
        // tool_invoke costs (paid catalog calls) come out of the tool pot.
        // Everything else (sub-agents, web_fetch summarizer, free dispatches)
        // is LLM-side cost — debit the LLM pot. Duplicate path still
        // accounts for the spend already incurred by the sub-agent.
        if (block.name === "tool_invoke") toolRemaining -= Number(dispatch.cost);
        else llmRemaining -= Number(dispatch.cost);
        if (dispatch.sub_run) {
          const collided: SubRun = {
            ...dispatch.sub_run,
            action: "entity_matched_existing",
            facts_set: 0,
            narrative: `(duplicate of \`${duplicateOf}\` — another sub-agent proposed this entity_id earlier in the same turn; events suppressed)`,
          };
          sub_runs.push(collided);
          for (const tc of dispatch.sub_run.tool_log) tool_log.push(tc);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `(duplicate proposal — \`${duplicateOf}\` was added by a parallel sub-agent this turn; this dispatch's events were suppressed to avoid a double-write)`,
          is_error: false,
        });
        continue;
      }

      // Same split as the duplicate-path above: tool_invoke debits the tool
      // pot, everything else (sub-agents, web_fetch, free) debits the LLM pot.
      if (block.name === "tool_invoke") toolRemaining -= Number(dispatch.cost);
      else llmRemaining -= Number(dispatch.cost);
      for (const ev of dispatch.events) {
        if (ev.type === "entity.created") {
          const id = String((ev.payload as { entity_id?: string }).entity_id ?? "");
          if (id) addedEntityIds.add(id);
        }
        events.push(ev);
        eventsEmittedThisIter++;
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
    // Compute this iter's tool-call signature: sorted JSON of
    // (name, input). Used for the sharp spin detector below.
    const iterSignature = JSON.stringify(
      toolUseBlocks
        .map((b) => [b.name, b.input])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );

    if (eventsEmittedThisIter === 0) {
      parentNoProgressStreak++;
      // Sharp spin detector: identical tool calls two iters in a row, no
      // events from either. Don't wait for the generous threshold — bail.
      if (iterSignature !== "" && iterSignature === lastIterSignature) {
        parentNoProgressStreak = Math.max(parentNoProgressStreak, 5);
      }
    } else {
      parentNoProgressStreak = 0;
    }
    lastIterSignature = iterSignature;
    messages.push({ role: "user", content: toolResults });
  }

  // ----- Phase 3: CitationAgent post-pass (Phase E) ----------------------
  // Verify every fact emitted during this run against its cited excerpt
  // using a Haiku-tier judge. Unsupported facts get a `fact.deprecated`
  // event appended so the dataset projection skips them — the original
  // `facts.set_many` event stays in the log for audit. This is the single
  // most important defense against synthesizer citation hallucination
  // (Anthropic's documented failure mode in multi-agent research systems).
  // Skip if the customer explicitly opted out OR if no facts were written.
  let verifySummary: VerifyReport | undefined;
  if (opts.verify_citations !== false && events.length > 0) {
    try {
      const verify = await verifyCitations({
        events,
        llm: opts.llm,
        run_id: opts.run_id,
        agent: opts.agent,
      });
      for (const dep of verify.deprecation_events) {
        events.push(dep);
        opts.onEvent?.(dep);
      }
      // Append verifier LLM calls to the iteration_log so customers see
      // total run cost in one place. Prefix iters with the parent's
      // current iter count so they're chronologically last.
      const offset = iteration_log.length;
      for (const entry of verify.iteration_log) {
        iteration_log.push({ ...entry, iter: offset + entry.iter });
      }
      verifySummary = {
        facts_checked: verify.summary.facts_checked,
        supported: verify.summary.supported,
        unsupported: verify.summary.unsupported,
        skipped_no_excerpt: verify.summary.skipped_no_excerpt,
        llm_cost: verify.llm_cost,
      };
      llmRemaining -= Number(verify.llm_cost);
    } catch (e) {
      // Don't fail the whole run if the verifier crashes — log on report
      // and let the customer see what was written without verification.
      verifySummary = {
        facts_checked: 0,
        supported: 0,
        unsupported: 0,
        skipped_no_excerpt: 0,
        llm_cost: "0",
        error: (e as Error).message,
      };
    }
  }

  return {
    events,
    tool_log,
    summary: `curate · ${schema.name}@${meta.sha.slice(0, 7)} · ${iter} iter · ${sub_runs.length} sub-agents · ${events.length} events · ${tool_log.length} tool calls · stop=${stopReason} · llm $${llmRemaining.toFixed(6)} · tool $${toolRemaining.toFixed(6)} remaining${verifySummary ? ` · verified ${verifySummary.supported}/${verifySummary.facts_checked}` : ""}`,
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
      // Legacy field — sum of remaining pots so older clients still see one number.
      budget_remaining: (llmRemaining + toolRemaining).toFixed(6),
      llm_budget_remaining: llmRemaining.toFixed(6),
      tool_budget_remaining: toolRemaining.toFixed(6),
      llm_summary: summary,
      ...(verifySummary ? { verify_citations: verifySummary } : {}),
    },
  };
}

interface VerifyReport {
  facts_checked: number;
  supported: number;
  unsupported: number;
  skipped_no_excerpt: number;
  llm_cost: string;
  error?: string;
}

interface DispatchContext {
  run_id: string;
  agent: string;
  frame_client: FrameClient;
  frame_url: string;
  refetcher: Refetcher;
  catalog: CatalogClient;
  /** paidFetch threaded from curate opts → catalog-dispatch POST branch. */
  paidFetch?: typeof fetch;
  /** Booted-wallet chains, threaded from curate opts → catalog-dispatch filter. */
  walletCapability?: { evm: boolean; solana: boolean; tempo: boolean };
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
    case "discover_entity":
      return await dispatchDiscoverEntity(input, ctx);
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
        // Thread the paid stack into the inline (no-DO) fallback path too —
        // sub-agents need catalog access in dev/smoketest just like in prod.
        catalog: ctx.catalog,
        paidFetch: ctx.paidFetch,
        walletCapability: ctx.walletCapability,
        env: ctx.env,
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

async function dispatchDiscoverEntity(
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolDispatchResult> {
  const hypothesis = String(input.hypothesis ?? "").trim();
  if (!hypothesis) return errorResult("hypothesis required (non-empty string)");
  const seed_urls = Array.isArray(input.seed_urls)
    ? (input.seed_urls as unknown[]).map(String).filter((u) => /^https?:\/\//.test(u))
    : undefined;
  const fields_to_find = Array.isArray(input.fields_to_find)
    ? (input.fields_to_find as unknown[]).map(String)
    : undefined;

  // Collect known entity_ids so the sub-loop can detect duplicates. Cheap
  // (frames-cloud iteration uses NDJSON, no per-entity overhead beyond
  // listing) but capped — beyond 500 entity_ids the model can't reasonably
  // scan the list anyway, so we pass the first 500 and trust the sub-loop
  // to investigate before proposing.
  const knownIds: string[] = [];
  try {
    for await (const ent of ctx.frame_client.iterateEntities(ctx.frame_url, { include: "first" })) {
      knownIds.push(ent.entity_id);
      if (knownIds.length >= 500) break;
    }
  } catch (e) {
    return errorResult(`failed to enumerate known entities: ${(e as Error).message}`);
  }

  // Stable DO name: ${run_id}:discover:${sha256(hypothesis).slice(0, 16)}.
  // Idempotent on retries; distinct hypotheses → distinct isolates → parallel.
  const hypoHash = createHash("sha256").update(hypothesis).digest("hex").slice(0, 16);

  const sub = ctx.env?.ENTITY_AGENT
    ? await ctx.env.ENTITY_AGENT.get(
        ctx.env.ENTITY_AGENT.idFromName(`${ctx.run_id}:discover:${hypoHash}`),
      ).discover({
        hypothesis,
        seed_urls,
        schema: ctx.schema,
        known_entity_ids: knownIds,
        fields_to_find,
        budget: "0.30",
        max_iters: 5,
        run_id: ctx.run_id,
        agent: ctx.agent,
      })
    : await discoverEntity({
        hypothesis,
        seed_urls,
        schema: ctx.schema,
        known_entity_ids: knownIds,
        fields_to_find,
        llm: ctx.llm,
        refetcher: ctx.refetcher,
        // Same paid-stack threading as the inline refresh path.
        catalog: ctx.catalog,
        paidFetch: ctx.paidFetch,
        walletCapability: ctx.walletCapability,
        env: ctx.env,
        budget: "0.30",
        max_iters: 5,
        run_id: ctx.run_id,
        agent: ctx.agent,
      });

  // Emit events when the sub-loop proposed a new entity. Match
  // add_entity_with_facts shape: one entity.created + one facts.set_many.
  const events: FrameEvent[] = [];
  if (sub.proposed_entity) {
    const ts = new Date().toISOString();
    events.push({
      id: randomUUID(),
      ts,
      type: "entity.created",
      agent: ctx.agent,
      run_id: ctx.run_id,
      payload: { entity_id: sub.proposed_entity.entity_id },
    });
    if (sub.proposed_entity.facts.length > 0) {
      events.push({
        id: randomUUID(),
        ts,
        type: "facts.set_many",
        agent: ctx.agent,
        run_id: ctx.run_id,
        payload: {
          entity_id: sub.proposed_entity.entity_id,
          facts: sub.proposed_entity.facts.map((f) => ({
            fact_id: randomUUID(),
            field: f.field,
            value: f.value,
            source: f.source,
          })),
        },
      });
    }
  }

  const action: SubRun["action"] =
    sub.stop_reason === "entity_proposed" ? "entity_added" :
    sub.stop_reason === "matched_existing" ? "entity_matched_existing" :
    sub.stop_reason === "no_match" ? "no_change" :
    "no_op";

  const factsCount = sub.proposed_entity?.facts.length ?? 0;
  const entityNote = sub.proposed_entity
    ? `proposed new entity \`${sub.proposed_entity.entity_id}\` with ${factsCount} fact(s)`
    : sub.matched_existing_entity_id
      ? `matched existing entity \`${sub.matched_existing_entity_id}\` — not adding`
      : "no match";

  const result_text = [
    `discover_entity(hypothesis="${hypothesis.slice(0, 80)}${hypothesis.length > 80 ? "…" : ""}") → ${action}`,
    `  stop_reason:   ${sub.stop_reason}`,
    `  outcome:       ${entityNote}`,
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
    sub_run: {
      // SubRun.entity_id is the proposed/matched id when known, otherwise a
      // stable placeholder derived from the hypothesis hash so customers can
      // correlate the sub-run with the originating call in the iteration_log.
      entity_id:
        sub.proposed_entity?.entity_id ??
        sub.matched_existing_entity_id ??
        `discover:${hypoHash}`,
      action,
      stop_reason: sub.stop_reason,
      facts_set: factsCount,
      deprecations: 0,
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
