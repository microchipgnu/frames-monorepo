// `refreshEntity` — a bounded sub-agent that researches a single entity and
// returns proposed facts. Used by curate.ts via the `refresh_entity` tool.
//
// Why this exists (Phase B of the cost-architecture redesign):
//   v0.0.13 fixed context compounding via Haiku summarization. But the
//   iteration_log showed the parent agent still over-explored — it ran 30
//   iterations and 41 tool calls to write 4 events, because each call was
//   cheap enough to keep going. Sub-agents solve this by giving the
//   research phase a hard structural boundary: per-entity, bounded context,
//   bounded iters, clear "I'm done" state.
//
// Each sub-loop:
//   - Sees ONLY the schema, the entity's current state, and any focus fields
//   - Has its own iteration budget (default 5)
//   - Has its own dollar budget (default $0.30)
//   - Returns a clean structured proposal: which facts to set, which to
//     deprecate, with sources. Parent decides whether to write.
//
// What this is NOT (yet):
//   - A Durable Object — Phase C promotes these to @cloudflare/agents DOs
//     for cross-request persistence + true parallelism beyond Worker CPU caps
//   - Concurrent — Phase C also adds parallel dispatch via Promise.all
//   - The only sub-agent shape — `discover_entity` would be the symmetric
//     "find candidates not in the dataset" sub-loop, coming next

import type { ToolCall } from "@frames-ag/tick-types";
import type { IterationLogEntry } from "@frames-ag/tick-types";
import type { FrameSchema } from "../frame-client";
import type { LlmClient, LlmContent, LlmMessage, LlmToolSpec } from "../llm/client";
import { summarizeForContext } from "../llm/summarize";
import type { Refetcher } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RefreshEntityOptions {
  /** Entity to refresh. Required. */
  entity_id: string;
  /**
   * Current state of the entity as observed by the parent.
   * Shape mirrors frames-cloud's entity response: `{ entity_id, fields,
   * fact_ids, evidence }`. Pass through verbatim; the sub-loop uses it
   * to decide what's stale vs what's missing.
   */
  entity_state: Record<string, unknown>;
  /** Schema for the dataset — tells the sub-loop what fields exist. */
  schema: FrameSchema;
  /** Optional focus list. When set, the sub-loop only investigates these fields. */
  focus?: string[];
  /** LLM client (shared with parent). Sub-loop uses `agent: "build"` for reasoning. */
  llm: LlmClient;
  /** Refetcher (shared with parent). Each fetch is summarized before reaching the sub-loop's context. */
  refetcher: Refetcher;
  /** Budget for this sub-loop (USDC). Default $0.30 — enough for 3-5 iters with summarized fetches. */
  budget?: string;
  /** Max iterations. Default 5 — sub-loops should be tight. */
  max_iters?: number;
  /** Parent's run_id for telemetry / receipt joining. */
  run_id: string;
  /** Parent's agent identifier (for tool.invoked event attribution if needed). */
  agent: string;
}

export interface ProposedFact {
  field: string;
  value: unknown;
  source: {
    url: string;
    retrieved_at: string;
    excerpt?: string;
    title?: string;
  };
}

export interface ProposedDeprecation {
  fact_id: string;
  reason: string;
}

export interface RefreshEntityResult {
  entity_id: string;
  /** Facts the sub-loop proposes to set / update. Parent decides to emit `facts.set_many`. */
  facts_to_set: ProposedFact[];
  /** Existing facts the sub-loop proposes to deprecate. Parent emits `fact.deprecated`. */
  facts_to_deprecate: ProposedDeprecation[];
  /** One-paragraph wrap-up from the sub-loop's model. */
  narrative: string;
  /** Per-LLM-call log for this sub-loop only. */
  iteration_log: IterationLogEntry[];
  /** Tool calls (fetches + summarizer calls) made by this sub-loop. */
  tool_log: ToolCall[];
  /** Sum of LLM cost (parent loop + summarizer) for this sub-loop. */
  llm_cost: string;
  /** Why the sub-loop stopped. */
  stop_reason:
    | "wrote_facts"
    | "no_change"
    | "budget_exhausted"
    | "max_iters"
    | "no_progress"
    | "error";
}

// ---------------------------------------------------------------------------
// Sub-loop implementation
// ---------------------------------------------------------------------------

/**
 * The sub-loop's tool palette is intentionally narrow:
 *   - `web_fetch` — same as parent but auto-summarized by Haiku
 *   - `propose_facts` — terminal write: returns the proposed facts back
 *     to the parent. Sub-loop stops after this is called.
 *   - `propose_deprecations` — terminal write: same shape, for deprecations.
 *   - `no_change` — terminal: nothing to update.
 * No `query`, no `catalog_*` — parent already loaded the state.
 */
const REFRESH_TOOLS: LlmToolSpec[] = [
  {
    name: "web_fetch",
    description:
      "Fetch a URL. The page is auto-summarized against the schema before you see it — you get ~500-2000 tokens of per-field excerpts. Use this to verify sources or find missing fields.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        entity_hint: { type: "string", description: "Optional: focus the summarizer on this entity." },
      },
      required: ["url"],
    },
  },
  {
    name: "propose_facts",
    description:
      "Propose facts to set on the entity. Terminal: the sub-loop stops after this call. Every fact must cite a source.url that you actually fetched. Returns control to the parent agent.",
    input_schema: {
      type: "object",
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: {},
              source: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  retrieved_at: { type: "string" },
                  excerpt: { type: "string" },
                  title: { type: "string" },
                },
                required: ["url", "retrieved_at"],
              },
            },
            required: ["field", "value", "source"],
          },
        },
        narrative: { type: "string", description: "One paragraph: what you verified, what you changed, why." },
      },
      required: ["facts", "narrative"],
    },
  },
  {
    name: "propose_deprecations",
    description:
      "Propose existing facts to deprecate (e.g. source is dead, value drifted). Terminal: stops the sub-loop. Reference fact_ids from the entity_state we gave you.",
    input_schema: {
      type: "object",
      properties: {
        deprecations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fact_id: { type: "string" },
              reason: { type: "string" },
            },
            required: ["fact_id", "reason"],
          },
        },
        narrative: { type: "string" },
      },
      required: ["deprecations", "narrative"],
    },
  },
  {
    name: "no_change",
    description:
      "Terminal: no facts need updating for this entity. Use when you've verified the existing data is still accurate and complete.",
    input_schema: {
      type: "object",
      properties: {
        narrative: { type: "string", description: "Why no change is needed." },
      },
      required: ["narrative"],
    },
  },
];

export async function refreshEntity(opts: RefreshEntityOptions): Promise<RefreshEntityResult> {
  const maxIters = opts.max_iters ?? 5;
  const budgetStart = Number(opts.budget ?? "0.30");
  let remaining = budgetStart;

  const iteration_log: IterationLogEntry[] = [];
  const tool_log: ToolCall[] = [];
  let totalLlmCost = 0;
  let maxLlmCostSeen = 0;

  const safetyFloor = 0.02;

  // Phase E.1 — fetch dedup. Sub-loops can web_fetch the same URL more than
  // once (model forgets it pulled it, or pulls it once "to scan" and again
  // "to verify"). Map keys are `${url} ${entity_hint}` — distinct hints
  // can legitimately produce distinct summaries. Cached entries return at
  // zero LLM/fetch cost.
  const fetchCache = new Map<string, { result_text: string }>();

  // Phase E.2 — evidence-aware early stop. Terminal tools break the outer
  // loop, so reaching the end of an iter means "non-terminal iter — only
  // fetches / errors happened." Count those in a row; break when the model
  // strings together too many no-progress iters.
  //
  // Threshold raised to 3 in v0.3.14 (matching discover's v0.3.1 fix).
  // Live data 2026-05-13 showed refresh sub-loops legitimately needing 2
  // fetches (human-facing URL + structured API endpoint) before a propose
  // when the page lacks readable numeric fields. With threshold 2, iter 3
  // (the propose iter) was being killed before the model could act.
  let nonTerminalStreak = 0;

  const facts_to_set: ProposedFact[] = [];
  const facts_to_deprecate: ProposedDeprecation[] = [];
  let narrative = "";
  let stop_reason: RefreshEntityResult["stop_reason"] = "max_iters";

  // ----- Phase 1: system + initial message ------------------------------
  const system = buildRefreshSystem(opts);
  const messages: LlmMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Refresh entity \`${opts.entity_id}\`.${opts.focus && opts.focus.length > 0
            ? ` Focus on fields: ${opts.focus.join(", ")}.`
            : " Verify all fields are still accurate; fill any missing fields if you can cite a source."}`,
        },
      ],
    },
  ];

  // ----- Phase 2: bounded sub-loop --------------------------------------
  let iter = 0;
  loop: while (iter < maxIters) {
    iter++;

    // Cost guard with projection — same pattern as curate.ts.
    const projected = maxLlmCostSeen > 0 ? maxLlmCostSeen * 1.2 : 0;
    if (remaining < safetyFloor || (projected > 0 && remaining < projected + safetyFloor)) {
      stop_reason = "budget_exhausted";
      narrative = `(sub-loop budget exhausted at iter ${iter} of ${maxIters}; ${facts_to_set.length} facts proposed before halt)`;
      break;
    }

    // Evidence-aware early stop: if the model has chained 3 consecutive
    // iters that only fetched (no propose / deprecate / no_change), it's
    // spinning. Bail before burning the rest of the iter cap on more dead
    // fetches. Sub-loops are short (≤5 iters) so worst-case wasted iters
    // when truly stuck is 2 — but legitimate 2-fetch convergence patterns
    // (HTML page + structured API) get their iter 3 to propose.
    if (nonTerminalStreak >= 3) {
      stop_reason = "no_progress";
      narrative = `(sub-loop stopped at iter ${iter} after 3 consecutive non-proposing iters — model not converging on this entity)`;
      break;
    }

    const llmRes = await opts.llm.call({
      system,
      messages,
      tools: REFRESH_TOOLS,
      agent: "build",
      max_tokens: 2048,
    });
    const llmCost = Number(llmRes.usage.estimated_cost);
    remaining -= llmCost;
    totalLlmCost += llmCost;
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

    messages.push({ role: "assistant", content: llmRes.content });

    if (llmRes.stop_reason === "end_turn") {
      // Model wrapped up without calling a terminal tool. Treat the text as the narrative.
      narrative = extractText(llmRes.content) || "(sub-loop ended without proposing changes)";
      stop_reason = "no_change";
      break;
    }
    if (llmRes.stop_reason !== "tool_use") {
      narrative = `(unexpected stop_reason: ${llmRes.stop_reason})`;
      stop_reason = "error";
      break;
    }

    // Dispatch every tool_use in the response.
    const toolResults: LlmContent[] = [];
    for (const block of llmRes.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "web_fetch") {
        const url = String((block.input as { url?: unknown }).url ?? "");
        if (!url || !/^https?:\/\//.test(url)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Invalid url; must be http(s).",
            is_error: true,
          });
          continue;
        }
        const entityHint = typeof (block.input as { entity_hint?: unknown }).entity_hint === "string"
          ? String((block.input as { entity_hint?: unknown }).entity_hint)
          : opts.entity_id;
        const cacheKey = `${url} | ${entityHint}`;
        const cached = fetchCache.get(cacheKey);
        if (cached) {
          // Dedup hit — return the prior summary with a leading marker so the
          // model can tell it's seen this and shouldn't re-fetch. No charge.
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `[cached fetch — already retrieved earlier this sub-loop]\n${cached.result_text}`,
          });
          continue;
        }
        const result = await opts.refetcher({
          url,
          remaining_budget: remaining.toFixed(6),
          run_id: opts.run_id,
        });
        const fetchCost = result.tool_call?.cost ?? "0";
        if (result.tool_call) tool_log.push(result.tool_call);
        if (!result.ok) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Fetch failed: ${result.error}`,
            is_error: true,
          });
          remaining -= Number(fetchCost);
          continue;
        }
        const summary = await summarizeForContext({
          body: result.body ?? "",
          schema: opts.schema,
          entity_hint: entityHint,
          source_url: url,
          final_url: result.final_url,
          llm: opts.llm,
        });
        remaining -= Number(fetchCost) + Number(summary.cost);
        totalLlmCost += Number(summary.cost);
        fetchCache.set(cacheKey, { result_text: summary.summary });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: summary.summary,
        });
        continue;
      }

      if (block.name === "propose_facts") {
        const input = block.input as { facts?: unknown; narrative?: unknown };
        if (Array.isArray(input.facts)) {
          for (const f of input.facts as Array<Record<string, unknown>>) {
            facts_to_set.push({
              field: String(f.field),
              value: f.value,
              source: (f.source as ProposedFact["source"]) ?? { url: "", retrieved_at: "" },
            });
          }
        }
        if (typeof input.narrative === "string") narrative = input.narrative;
        stop_reason = "wrote_facts";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `OK — ${facts_to_set.length} fact(s) recorded; returning to parent.`,
        });
        messages.push({ role: "user", content: toolResults });
        break loop;
      }

      if (block.name === "propose_deprecations") {
        const input = block.input as { deprecations?: unknown; narrative?: unknown };
        if (Array.isArray(input.deprecations)) {
          for (const d of input.deprecations as Array<Record<string, unknown>>) {
            facts_to_deprecate.push({
              fact_id: String(d.fact_id),
              reason: String(d.reason),
            });
          }
        }
        if (typeof input.narrative === "string") narrative = input.narrative;
        stop_reason = "wrote_facts";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `OK — ${facts_to_deprecate.length} deprecation(s) recorded; returning to parent.`,
        });
        messages.push({ role: "user", content: toolResults });
        break loop;
      }

      if (block.name === "no_change") {
        const input = block.input as { narrative?: unknown };
        if (typeof input.narrative === "string") narrative = input.narrative;
        stop_reason = "no_change";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "OK — recorded no_change; returning to parent.",
        });
        messages.push({ role: "user", content: toolResults });
        break loop;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Unknown tool in sub-loop: ${block.name}`,
        is_error: true,
      });
    }
    // Reaching here means no terminal tool fired this iter — only web_fetches
    // (or errors). Increment the streak; the next iter's top-of-loop check
    // will bail if we're at 2 in a row.
    nonTerminalStreak++;
    messages.push({ role: "user", content: toolResults });
  }

  return {
    entity_id: opts.entity_id,
    facts_to_set,
    facts_to_deprecate,
    narrative,
    iteration_log,
    tool_log,
    llm_cost: totalLlmCost.toFixed(6),
    stop_reason,
  };
}

// ---------------------------------------------------------------------------
// System prompt for the sub-loop
// ---------------------------------------------------------------------------

function buildRefreshSystem(opts: RefreshEntityOptions): string {
  const lines: string[] = [];
  lines.push("# tick refresh-entity sub-agent");
  lines.push("");
  lines.push(
    `You are a bounded research sub-agent invoked by the parent curate loop. Your job: verify and update facts for ONE entity (\`${opts.entity_id}\`). Stay focused — your iteration budget is small.`,
  );
  lines.push("");
  lines.push("## Loop shape");
  lines.push("");
  lines.push("1. Look at the entity's current state (below). Identify fields that look stale or missing.");
  lines.push("2. Use `web_fetch(url)` to verify or fill them. Each fetched page is auto-summarized to ~500-2000 tokens before you see it.");
  lines.push("3. **Commit by iter 2.** After ONE fetch that confirms or contradicts the current state, propose. Do not fetch a second source to corroborate the first if the first was already informative.");
  lines.push("4. Call exactly ONE terminal tool:");
  lines.push("   - `propose_facts` — set facts (terminal)");
  lines.push("   - `propose_deprecations` — deprecate stale fact_ids (terminal)");
  lines.push("   - `no_change` — nothing to update (terminal)");
  lines.push("");
  lines.push("## When to commit vs reject");
  lines.push("");
  lines.push("**Propose / deprecate when:**");
  lines.push("- You've fetched ONE source that shows the field values (current or revised). That's enough. The entity already exists with prior evidence; you're adding a fresh data point, not building a case.");
  lines.push("- Note: you start with the entity's existing facts loaded. If the new fetch matches, call `no_change`. If it contradicts, call `propose_facts` or `propose_deprecations`.");
  lines.push("");
  lines.push("**Avoid the over-corroboration trap:**");
  lines.push("- Do NOT fetch the GitHub UI page, then the GitHub API, then the README, then a wiki — that's the 4-fetch pattern that times out before you propose. Pick ONE source per field, propose, return.");
  lines.push("- If the entity hasn't changed, `no_change` is the correct call. It's not a failure; it's the expected outcome on a stable entity.");
  lines.push("");
  lines.push("## Hard rules");
  lines.push("");
  lines.push("- Every proposed fact MUST cite a `source.url` that you actually fetched in this sub-loop.");
  lines.push("- `source.retrieved_at` MUST be the timestamp the page was fetched.");
  lines.push("- `source.excerpt` SHOULD be a verbatim quote (≤2 sentences) supporting the value.");
  lines.push("- Don't invent values. If you can't find a source, leave the field alone.");
  lines.push("- Do NOT fetch a second source just to feel more confident. One confirming fetch is enough; `no_change` is fine if the data looks current.");
  lines.push("");
  lines.push("## Schema");
  lines.push("");
  lines.push(`Dataset: \`${opts.schema.name}\`${opts.schema.entity_type ? ` (entities are ${opts.schema.entity_type})` : ""}`);
  if (opts.schema.description) {
    lines.push(`Description: ${opts.schema.description}`);
  }
  lines.push("");
  lines.push("Fields:");
  for (const [name, def] of Object.entries(opts.schema.fields)) {
    const d = def as { type?: string; required?: boolean; values?: string[]; description?: string };
    const req = d.required ? " (required)" : "";
    const enumPart = d.values ? ` ∈ {${d.values.join(", ")}}` : "";
    const desc = d.description ? ` — ${d.description}` : "";
    lines.push(`  - \`${name}\`: ${d.type ?? "string"}${enumPart}${req}${desc}`);
  }
  lines.push("");
  if (opts.focus && opts.focus.length > 0) {
    lines.push("## Focus");
    lines.push("");
    lines.push(`The parent asked you to focus on these fields: ${opts.focus.join(", ")}. You may still verify other fields if convenient, but prioritize these.`);
    lines.push("");
  }
  lines.push("## Current entity state");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(opts.entity_state, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Budget`);
  lines.push(`You have **$${opts.budget ?? "0.30"} USDC** for LLM tokens + paid tool calls. Tight budget; stop as soon as you have enough to propose.`);

  return lines.join("\n");
}

function extractText(content: LlmContent[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
