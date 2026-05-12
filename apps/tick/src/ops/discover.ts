// `discover` op — search-only candidate proposer.
//
// Same agent-loop shape as `curate`, but:
//   - Different tool palette: read + web_fetch + propose_entity (NO mutations)
//   - Candidates accumulate into `report.candidates` instead of frame events
//   - Empty `events` array in the response — human review queue is the writer
//
// Use case: customer wants to expand the dataset but doesn't trust the agent
// to write directly. `discover` proposes (entity_id, fields, sources) tuples;
// customer reviews them in a PR and decides which to commit (typically by
// calling `curate` or running the entries through their own admit pipeline).

import type { ToolCall } from "@frames-ag/tick-types";
import { CatalogClient } from "../catalog/client";
import { FrameClient, type FrameMeta, type FrameSchema } from "../frame-client";
import { LlmClient, type LlmContent, type LlmMessage, type LlmToolSpec } from "../llm/client";
import {
  dispatchCatalogGet,
  dispatchCatalogSearch,
  dispatchToolInvoke,
} from "./catalog-dispatch";
import type { OpOutcome, Refetcher } from "./types";

export interface DiscoverOptions {
  frame_url: string;
  budget: string;
  run_id: string;
  agent: string;
  refetcher: Refetcher;
  client?: FrameClient;
  catalog?: CatalogClient;
  llm: LlmClient;
  /** Capability hints — narrow the search. e.g. ["web-search", "scrape"]. */
  capability_hints?: string[];
  /** Max iterations defense. Default 20 (lower than curate; discovery is bounded). */
  max_iters?: number;
  safety_floor?: string;
  /** Worker env for receipt signing in tool_invoke. */
  env?: { AUDIT_PRIVATE_KEY?: string };
  /** Optional progressive event callback (SSE response path). */
  onEvent?: (event: import("@frames-ag/tick-types").FrameEvent) => void;
  /**
   * Optional customer-supplied prompt. Appended to the system prompt. Typically
   * the contents of `<dataset>/prompt.md` from the CLI's auto-discovery.
   */
  custom_prompt?: string;
}

interface ProposedCandidate {
  entity_id: string;
  fields: Record<string, unknown>;
  sources: Array<{ url: string; retrieved_at: string; title?: string; excerpt?: string }>;
  rationale: string;
}

const sourceSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    retrieved_at: { type: "string" },
    title: { type: "string" },
    excerpt: { type: "string" },
  },
  required: ["url", "retrieved_at"],
};

const DISCOVER_TOOLS: LlmToolSpec[] = [
  {
    name: "query",
    description:
      "Read current frame state to avoid proposing entities that already exist. `mode=all` lists every current entity_id; `mode=entity` returns a single entity.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "entity"] },
        entity_id: { type: "string", description: "required when mode=entity" },
      },
      required: ["mode"],
    },
  },
  {
    name: "catalog_search",
    description:
      "Search the federated tool catalog for paid tools matching a capability. Use this BEFORE web_fetch when you need a kind of tool (e.g. capability='web-search', 'scrape'). Returns slim ToolDescriptors with id, title, payment.price_hint.",
    input_schema: {
      type: "object",
      properties: {
        capability: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "catalog_get",
    description: "Resolve a single ToolDescriptor by id, including full schemas.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "tool_invoke",
    description:
      "Invoke a catalog tool by descriptor id. The runtime resolves the descriptor and calls it via paidFetch (x402/MPP handled automatically). Preferred over web_fetch when the catalog has a matching descriptor.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
      required: ["id"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fallback: direct fetch of a URL. Use when the catalog has no matching descriptor (raw GitHub READMEs, vendor docs pages). Returns body up to 64 KB.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "propose_entity",
    description:
      "Propose a candidate entity for human review. Does NOT write to the frame. Every field must cite a source. Customer's review queue decides whether to admit.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Suggested slug for the candidate" },
        fields: {
          type: "object",
          description: "Suggested values per field name from schema.yml",
        },
        sources: {
          type: "array",
          items: sourceSchema,
          description: "Sources backing the proposed values. At least one required.",
        },
        rationale: {
          type: "string",
          description: "One-sentence explanation of why this entity fits the dataset scope",
        },
      },
      required: ["entity_id", "fields", "sources", "rationale"],
    },
  },
];

export async function discover(opts: DiscoverOptions): Promise<OpOutcome> {
  const client = opts.client ?? new FrameClient();
  const catalog = opts.catalog ?? new CatalogClient();
  const maxIters = opts.max_iters ?? 20;
  const safetyFloor = Number(opts.safety_floor ?? "0.03");
  let remaining = Number(opts.budget);

  const meta: FrameMeta = await client.getMeta(opts.frame_url);
  const schema: FrameSchema = await client.getSchema(opts.frame_url);
  let readme: string | undefined;
  try {
    readme = await client.getReadme(opts.frame_url);
  } catch {
    // optional
  }

  const system = buildDiscoverSystem({
    meta,
    schema,
    readme,
    capability_hints: opts.capability_hints,
    budget: opts.budget,
    custom_prompt: opts.custom_prompt,
  });

  const messages: LlmMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Begin discovery. Propose candidate entities that fit this dataset's scope but aren't already in it. Use web_fetch + your knowledge to find candidates with real sources.",
        },
      ],
    },
  ];

  const candidates: ProposedCandidate[] = [];
  const tool_log: ToolCall[] = [];
  // tool.invoked receipts emitted by paid web_fetches + tool_invoke dispatches.
  // discover doesn't mutate the frame, but these MUST land in the run's event
  // stream so receipts can be audited offline (and cited by future curate
  // calls promoting the proposed entity).
  const events: import("@frames-ag/tick-types").FrameEvent[] = [];

  let iter = 0;
  let stopReason = "max_iters";
  let summary = "(no summary)";
  // See curate.ts for the rationale — project next iter's LLM cost so we
  // halt before a budget overrun, not after.
  let maxLlmCostSeen = 0;
  const iteration_log: import("@frames-ag/tick-types").IterationLogEntry[] = [];

  while (iter < maxIters) {
    iter++;

    const projectedLlmCost = maxLlmCostSeen > 0 ? maxLlmCostSeen * 1.2 : 0;
    if (remaining < safetyFloor || (projectedLlmCost > 0 && remaining < projectedLlmCost + safetyFloor)) {
      stopReason = "budget_exhausted";
      summary = `(budget exhausted at iter ${iter}; ${candidates.length} candidates proposed before halt)`;
      break;
    }

    const llmRes = await opts.llm.call({
      system,
      messages,
      tools: DISCOVER_TOOLS,
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
    });
    messages.push({ role: "assistant", content: llmRes.content });

    if (llmRes.stop_reason === "end_turn") {
      stopReason = "end_turn";
      summary = extractText(llmRes.content) || "(discovery complete)";
      break;
    }
    if (llmRes.stop_reason !== "tool_use") {
      stopReason = llmRes.stop_reason;
      summary = `unexpected stop: ${llmRes.stop_reason}`;
      break;
    }

    const toolResults: LlmContent[] = [];
    for (const block of llmRes.content) {
      if (block.type !== "tool_use") continue;

      let resultText: string;
      let isError = false;

      if (block.name === "query") {
        if (block.input.mode === "all") {
          const ids: string[] = [];
          for await (const ent of client.iterateEntities(opts.frame_url, { include: "first" })) {
            ids.push(ent.entity_id);
          }
          resultText = JSON.stringify({ existing_entity_ids: ids });
        } else if (block.input.mode === "entity") {
          const ent = await client.getEntity(opts.frame_url, String(block.input.entity_id), "all");
          resultText = JSON.stringify(ent ?? { error: "not_found" });
        } else {
          resultText = `unknown query mode: ${block.input.mode}`;
          isError = true;
        }
      } else if (block.name === "web_fetch") {
        const url = String(block.input.url);
        const r = await opts.refetcher({
          url,
          remaining_budget: remaining.toFixed(6),
          run_id: opts.run_id,
        });
        if (r.tool_call) {
          tool_log.push(r.tool_call);
          remaining -= Number(r.tool_call.cost);
        }
        if (r.event) {
          events.push(r.event);
          opts.onEvent?.(r.event);
        }
        if (!r.ok) {
          resultText = `Fetch failed: ${r.error}`;
          isError = true;
        } else {
          const body = (r.body ?? "").slice(0, 64 * 1024);
          resultText = `Fetched ${r.final_url} (${body.length} bytes, $${r.tool_call?.cost ?? "0"}):\n\n${body}`;
        }
      } else if (
        block.name === "catalog_search" ||
        block.name === "catalog_get" ||
        block.name === "tool_invoke"
      ) {
        const catalogCtx = {
          catalog,
          refetcher: opts.refetcher,
          run_id: opts.run_id,
          remaining_budget: remaining.toFixed(6),
          agent: opts.agent,
          env: opts.env,
        };
        const dispatch =
          block.name === "catalog_search"
            ? await dispatchCatalogSearch(block.input, catalogCtx)
            : block.name === "catalog_get"
              ? await dispatchCatalogGet(block.input, catalogCtx)
              : await dispatchToolInvoke(block.input, catalogCtx);
        if (dispatch.tool_call) {
          tool_log.push(dispatch.tool_call);
          remaining -= Number(dispatch.cost);
        }
        for (const ev of dispatch.events) {
          events.push(ev);
          opts.onEvent?.(ev);
        }
        resultText = dispatch.result_text;
        isError = dispatch.is_error;
      } else if (block.name === "propose_entity") {
        const input = block.input as Record<string, unknown>;
        if (!input.entity_id || !input.fields || !input.sources || !input.rationale) {
          resultText = "entity_id, fields, sources, and rationale are all required";
          isError = true;
        } else {
          candidates.push({
            entity_id: String(input.entity_id),
            fields: input.fields as Record<string, unknown>,
            sources: input.sources as ProposedCandidate["sources"],
            rationale: String(input.rationale),
          });
          resultText = `Proposed ${input.entity_id}. ${candidates.length} candidate(s) so far.`;
        }
      } else {
        resultText = `Unknown tool: ${block.name}`;
        isError = true;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultText,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    // discover doesn't mutate the frame, but does emit `tool.invoked` receipts
    // for every paid web_fetch / tool_invoke so spend is auditable.
    events,
    tool_log,
    summary: `discover · ${schema.name}@${meta.sha.slice(0, 7)} · ${iter} iter · ${candidates.length} candidates proposed · ${events.length} receipts · stop=${stopReason} · $${remaining.toFixed(6)} remaining`,
    iteration_log,
    report: {
      schema_name: schema.name,
      sha: meta.sha,
      iterations: iter,
      stop_reason: stopReason,
      candidates,
      budget_remaining: remaining.toFixed(6),
      llm_summary: summary,
    },
  };
}

function buildDiscoverSystem(args: {
  meta: FrameMeta;
  schema: FrameSchema;
  readme?: string;
  capability_hints?: string[];
  budget: string;
  custom_prompt?: string;
}): string {
  const lines: string[] = [];
  lines.push("# tick discover agent");
  lines.push("");
  lines.push(
    "You are the tick discover agent. Your job is to PROPOSE candidate entities that fit this dataset's scope but aren't already in it. You do NOT write to the frame directly — every candidate goes to a human review queue.",
  );
  lines.push("");
  lines.push("## Loop");
  lines.push("");
  lines.push("1. Call `query(mode=all)` to see what entity_ids already exist (skip them).");
  lines.push("2. Use `web_fetch(url)` to fetch candidate-source pages. Reach for authoritative pages (vendor blogs, GitHub README/release pages, regulatory filings) — never homepages.");
  lines.push("3. For each candidate that fits the scope: call `propose_entity` with a slug-shaped entity_id, suggested fields per schema, real sources, and a one-sentence rationale.");
  lines.push("4. Stop when you have a reasonable batch (5–10 strong candidates) or you've exhausted obvious sources.");
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push("- Every proposed field MUST cite a real `source.url` you actually fetched.");
  lines.push("- Never propose an entity already in the dataset.");
  lines.push("- Prefer 5 well-sourced candidates over 20 thin ones.");
  lines.push("- If you can't find at least 2 sources per candidate, skip it.");
  lines.push("");
  lines.push("## Dataset");
  lines.push("");
  lines.push(`- **name:** ${args.schema.name}`);
  lines.push(`- **entity_type:** ${args.schema.entity_type ?? "(unspecified)"}`);
  if (args.schema.description) lines.push(`- **description:** ${args.schema.description}`);
  lines.push(`- **current_entities:** ${args.meta.entity_count}`);
  lines.push("");
  lines.push("### Fields (from schema.yml)");
  lines.push("");
  for (const [name, def] of Object.entries(args.schema.fields)) {
    const req = def.required ? " (required)" : "";
    const values = def.values ? ` ∈ {${def.values.join(", ")}}` : "";
    lines.push(`- \`${name}\`: ${def.type}${values}${req}${def.description ? ` — ${def.description}` : ""}`);
  }
  lines.push("");
  if (args.readme) {
    lines.push("## Scope (from README.md)");
    lines.push("");
    lines.push(args.readme.slice(0, 4000));
    if (args.readme.length > 4000) lines.push("\n[README truncated]");
    lines.push("");
  }
  if (args.capability_hints && args.capability_hints.length > 0) {
    lines.push("## Capability hints");
    lines.push("");
    lines.push(`Customer suggested focusing on: ${args.capability_hints.join(", ")}.`);
    lines.push("");
  }
  lines.push("## Budget");
  lines.push(`You have **${args.budget} USDC**. Each web_fetch + LLM turn decrements it. Wrap up cleanly before exhaustion.`);
  if (args.custom_prompt) {
    lines.push("");
    lines.push("## Customer instructions (from prompt.md)");
    lines.push("");
    lines.push(args.custom_prompt);
  }
  return lines.join("\n");
}

function extractText(content: LlmContent[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
