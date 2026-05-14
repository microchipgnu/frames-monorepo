// `discoverEntity` — a bounded sub-agent that researches ONE hypothesized
// new entity and returns either a proposed entity + facts, a "this already
// exists" match against the dataset, or a "no_match" verdict. Symmetric
// counterpart to `refreshEntity` for dataset EXPAND-mode work.
//
// Why this exists (Phase F):
//   Phase B added `refresh_entity` so the curate loop could fan out across
//   existing entities. But that left a glaring asymmetry: when the parent
//   agent identifies a candidate entity that *should* exist in the dataset
//   (from a news article, a directory page, schema scope reading…), it had
//   nowhere to fan out the research. It had to inline the fetch/verify
//   cycle in its own context — exactly the cost-compounding pattern Phase
//   B was built to prevent. discover_entity closes that gap.
//
// Each sub-loop:
//   - Sees ONLY the schema, the hypothesis, optional seed URLs, the list
//     of known entity_ids (so it can detect "this is already in the
//     dataset, don't propose a dupe"), and the focus fields
//   - Has its own iteration budget (default 5)
//   - Has its own dollar budget (default $0.30)
//   - Returns a structured result: propose a new entity + facts, match an
//     existing entity_id, or no_match. Parent decides whether to write.
//
// Tool palette intentionally narrow — same shape as refresh_entity:
//   - web_fetch (with cache + Haiku summarize, like refresh)
//   - propose_new_entity (terminal: entity_id + facts)
//   - propose_match_existing (terminal: dupe of known entity_id)
//   - no_match (terminal: hypothesis can't be verified / isn't a real entity)
//
// Returns plug into the parent the same way refresh's sub_run does. The
// parent emits the actual `entity.created` + `facts.set_many` events from
// the proposal.

import type { ToolCall } from "@frames-ag/tick-types";
import type { IterationLogEntry } from "@frames-ag/tick-types";
import type { FrameSchema } from "../frame-client";
import type { LlmClient, LlmContent, LlmMessage, LlmToolSpec } from "../llm/client";
import { summarizeForContext } from "../llm/summarize";
import {
  dispatchCatalogGet,
  dispatchCatalogSearch,
  dispatchToolInvoke,
} from "./catalog-dispatch";
import type { Refetcher } from "./types";
import type { ProposedFact } from "./refresh-entity";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoverEntityOptions {
  /** Natural-language description of the candidate. Required. */
  hypothesis: string;
  /**
   * Optional URLs the parent already identified as relevant. The sub-loop
   * fetches these first (saves an exploration iter). Each fetch is auto-
   * summarized against the schema before the sub-loop sees the content.
   */
  seed_urls?: string[];
  /** Schema for the dataset. */
  schema: FrameSchema;
  /**
   * Existing entity_ids in the dataset. The sub-loop checks proposals
   * against this list to avoid duplicates; calls `propose_match_existing`
   * when the hypothesis turns out to describe a known entity.
   */
  known_entity_ids: string[];
  /** Optional focus list: schema fields the parent wants gathered. */
  fields_to_find?: string[];
  /** LLM client. */
  llm: LlmClient;
  /** Refetcher. Each fetch summarized + cached. */
  refetcher: Refetcher;
  /**
   * Catalog client — when provided, the sub-agent gains `catalog_search`,
   * `catalog_get`, `tool_invoke`. Same pattern as `RefreshEntityOptions`.
   */
  catalog?: import("../catalog/client").CatalogClient;
  /** paidFetch for x402/MPP 402 challenges on tool_invoke POST endpoints. */
  paidFetch?: typeof fetch;
  /** Booted-wallet chains; threaded into catalog_search's filter. */
  walletCapability?: { evm: boolean; solana: boolean; tempo: boolean };
  /** Worker env — for catalog dispatch receipt signing. */
  env?: { AUDIT_PRIVATE_KEY?: string };
  /** Budget for this sub-loop (USDC). Default $0.30. */
  budget?: string;
  /** Max iterations. Default 5. */
  max_iters?: number;
  /** Parent's run_id. */
  run_id: string;
  /** Parent's agent identifier. */
  agent: string;
}

export interface DiscoverEntityResult {
  hypothesis: string;
  /** Set when the sub-loop proposes a new entity. */
  proposed_entity?: {
    entity_id: string;
    facts: ProposedFact[];
  };
  /** Set when the sub-loop matched the hypothesis to an existing entity. */
  matched_existing_entity_id?: string;
  /** One-paragraph wrap-up. */
  narrative: string;
  iteration_log: IterationLogEntry[];
  tool_log: ToolCall[];
  /** Sum of LLM cost (sub-loop + summarizer) for this run. */
  llm_cost: string;
  stop_reason:
    | "entity_proposed"
    | "matched_existing"
    | "no_match"
    | "budget_exhausted"
    | "max_iters"
    | "no_progress"
    | "error";
}

// ---------------------------------------------------------------------------
// Sub-loop tool palette
// ---------------------------------------------------------------------------

const DISCOVER_TOOLS: LlmToolSpec[] = [
  {
    name: "web_fetch",
    description:
      "Fetch a URL. Page auto-summarized against the schema before you see it (~500-2000 tokens of per-field excerpts). Use to verify the hypothesis or gather field values.",
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
    name: "propose_new_entity",
    description:
      "Propose a new entity to add to the dataset. Terminal: the sub-loop stops after this call. Every fact must cite a `source.url` you actually fetched. Returns control to the parent agent.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "Stable identifier for the new entity. Slug-style preferred (e.g., 'acme-biotech'). Must not match any known entity_id.",
        },
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
        narrative: { type: "string", description: "One paragraph: what you found, why this is a real entity, why it belongs in the dataset." },
      },
      required: ["entity_id", "facts", "narrative"],
    },
  },
  {
    name: "propose_match_existing",
    description:
      "Terminal: the hypothesis turns out to describe an entity already in the dataset (known_entity_ids). Use this when investigation reveals the candidate is a known entity under a different name. Parent does NOT add anything.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "The existing entity_id this hypothesis matches." },
        narrative: { type: "string" },
      },
      required: ["entity_id", "narrative"],
    },
  },
  {
    name: "no_match",
    description:
      "Terminal: the hypothesis cannot be verified against sources, OR turns out not to be a real entity, OR is out of scope for the schema. Use this rather than fabricating an entity.",
    input_schema: {
      type: "object",
      properties: {
        narrative: { type: "string", description: "Why the hypothesis was rejected (no sources / out of scope / fabricated / etc)." },
      },
      required: ["narrative"],
    },
  },
];

/**
 * Catalog tools — surfaced when `opts.catalog` is wired in. Same shape as
 * refresh-entity's CATALOG_TOOLS. Discover sub-agents benefit even more
 * from catalog access because they're trying to find a new entity from
 * scratch — paid search/enrich descriptors return more structured starting
 * data than blindly summarizing whatever URL Sonnet guessed.
 */
const DISCOVER_CATALOG_TOOLS: LlmToolSpec[] = [
  {
    name: "catalog_search",
    description:
      "Search the federated tool catalog for paid tools matching a capability tag (e.g. 'web-search', 'enrich', 'scrape', 'social', 'markets'). Returns descriptors filtered to ones the runtime can actually pay. PREFER THIS over web_fetch when investigating an entity from scratch — paid search/enrich descriptors return structured first-class fields the summarizer would otherwise strip.",
    input_schema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description: "Capability tag — e.g. 'web-search', 'enrich', 'scrape', 'social', 'markets'.",
        },
        limit: { type: "number", description: "Max results (1–50). Default 10." },
      },
    },
  },
  {
    name: "catalog_get",
    description: "Resolve a single descriptor by id. Use after `catalog_search` when you need the full param schema.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "tool_invoke",
    description:
      "Invoke a paid catalog tool. The runtime handles x402 / MPP payment automatically. On a 4xx error the result includes `Parsed hints:` — read the hint kinds and retry once with corrected args if `retryable: true`.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ToolDescriptor id from catalog_search." },
        args: {
          type: "object",
          description: "Arguments matching descriptor.invocation.params_schema.",
          additionalProperties: true,
        },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Sub-loop implementation
// ---------------------------------------------------------------------------

export async function discoverEntity(opts: DiscoverEntityOptions): Promise<DiscoverEntityResult> {
  const maxIters = opts.max_iters ?? 5;
  const budgetStart = Number(opts.budget ?? "0.30");
  let remaining = budgetStart;

  const iteration_log: IterationLogEntry[] = [];
  const tool_log: ToolCall[] = [];
  let totalLlmCost = 0;
  let maxLlmCostSeen = 0;

  const safetyFloor = 0.02;

  // Phase E.1 — fetch dedup, same shape as refresh-entity.
  const fetchCache = new Map<string, { result_text: string }>();
  // Phase E.2 — evidence-aware early stop on non-terminal iters.
  // Threshold is HIGHER for discover than for refresh (refresh uses 2):
  // refresh has pre-loaded entity_state, so one fetch usually suffices
  // before a propose. Discover starts with only a hypothesis, so the
  // typical convergence pattern is fetch-seed → fetch-corroborator →
  // propose (3 iters). The original v0.3.0 threshold of 2 killed every
  // discover that needed two fetches before deciding — live measurement
  // 2026-05-13 showed 13/17 discover sub-loops aborted before iter 3.
  let nonTerminalStreak = 0;

  let proposed_entity: DiscoverEntityResult["proposed_entity"];
  let matched_existing_entity_id: string | undefined;
  let narrative = "";
  let stop_reason: DiscoverEntityResult["stop_reason"] = "max_iters";

  // ----- Phase 1: system + initial message -------------------------------
  const system = buildDiscoverSystem(opts);
  const messages: LlmMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildInitialUserText(opts),
        },
      ],
    },
  ];

  // ----- Phase 2: bounded sub-loop ---------------------------------------
  let iter = 0;
  loop: while (iter < maxIters) {
    iter++;

    const projected = maxLlmCostSeen > 0 ? maxLlmCostSeen * 1.2 : 0;
    if (remaining < safetyFloor || (projected > 0 && remaining < projected + safetyFloor)) {
      stop_reason = "budget_exhausted";
      narrative = `(discover sub-loop budget exhausted at iter ${iter} of ${maxIters})`;
      break;
    }

    if (nonTerminalStreak >= 3) {
      stop_reason = "no_progress";
      narrative = `(discover sub-loop stopped at iter ${iter} after 3 consecutive non-decisive iters)`;
      break;
    }

    const llmRes = await opts.llm.call({
      system,
      messages,
      // Append catalog tools when a CatalogClient is wired in. Same pattern
      // as refresh-entity — sub-agent gets paid catalog access only when
      // the EntityAgent DO had the env to boot the wallet stack.
      tools: opts.catalog ? [...DISCOVER_TOOLS, ...DISCOVER_CATALOG_TOOLS] : DISCOVER_TOOLS,
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
      narrative = extractText(llmRes.content) || "(discover sub-loop ended without a verdict)";
      stop_reason = "no_match";
      break;
    }
    if (llmRes.stop_reason !== "tool_use") {
      narrative = `(unexpected stop_reason in discover sub-loop: ${llmRes.stop_reason})`;
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
          : opts.hypothesis.slice(0, 80);
        const cacheKey = `${url} | ${entityHint}`;
        const cached = fetchCache.get(cacheKey);
        if (cached) {
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

      // Catalog tools — only when opts.catalog is wired in. Mirrors the
      // dispatch block in refresh-entity.ts; sub-loop scope means we don't
      // emit frame events from here, just surface the tool_result back to
      // the LLM.
      if (
        opts.catalog &&
        (block.name === "catalog_search" || block.name === "catalog_get" || block.name === "tool_invoke")
      ) {
        const catalogCtx = {
          catalog: opts.catalog,
          refetcher: opts.refetcher,
          paidFetch: opts.paidFetch,
          walletCapability: opts.walletCapability,
          run_id: opts.run_id,
          remaining_budget: remaining.toFixed(6),
          agent: opts.agent,
          env: opts.env,
        };
        const dispatch =
          block.name === "catalog_search"
            ? await dispatchCatalogSearch(block.input as Record<string, unknown>, catalogCtx)
            : block.name === "catalog_get"
              ? await dispatchCatalogGet(block.input as Record<string, unknown>, catalogCtx)
              : await dispatchToolInvoke(block.input as Record<string, unknown>, catalogCtx);
        remaining -= Number(dispatch.cost);
        if (dispatch.tool_call) tool_log.push(dispatch.tool_call);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: dispatch.result_text,
          is_error: dispatch.is_error,
        });
        continue;
      }

      if (block.name === "propose_new_entity") {
        const input = block.input as { entity_id?: unknown; facts?: unknown; narrative?: unknown };
        const entity_id = String(input.entity_id ?? "").trim();
        if (!entity_id) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "entity_id required (non-empty string).",
            is_error: true,
          });
          // Don't break — let the model retry. Counts as a non-decisive iter.
          continue;
        }
        if (opts.known_entity_ids.includes(entity_id)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `entity_id "${entity_id}" already exists in the dataset. Use propose_match_existing if this hypothesis matches an existing entity, or pick a different entity_id.`,
            is_error: true,
          });
          continue;
        }
        const factsRaw = Array.isArray(input.facts) ? (input.facts as Array<Record<string, unknown>>) : [];
        proposed_entity = {
          entity_id,
          facts: factsRaw.map((f) => ({
            field: String(f.field),
            value: f.value,
            source: (f.source as ProposedFact["source"]) ?? { url: "", retrieved_at: "" },
          })),
        };
        if (typeof input.narrative === "string") narrative = input.narrative;
        stop_reason = "entity_proposed";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `OK — proposed new entity \`${entity_id}\` with ${proposed_entity.facts.length} fact(s); returning to parent.`,
        });
        messages.push({ role: "user", content: toolResults });
        break loop;
      }

      if (block.name === "propose_match_existing") {
        const input = block.input as { entity_id?: unknown; narrative?: unknown };
        matched_existing_entity_id = String(input.entity_id ?? "").trim();
        if (typeof input.narrative === "string") narrative = input.narrative;
        stop_reason = "matched_existing";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `OK — matched existing entity \`${matched_existing_entity_id}\`; returning to parent.`,
        });
        messages.push({ role: "user", content: toolResults });
        break loop;
      }

      if (block.name === "no_match") {
        const input = block.input as { narrative?: unknown };
        if (typeof input.narrative === "string") narrative = input.narrative;
        stop_reason = "no_match";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "OK — recorded no_match; returning to parent.",
        });
        messages.push({ role: "user", content: toolResults });
        break loop;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Unknown tool in discover sub-loop: ${block.name}`,
        is_error: true,
      });
    }
    // Non-terminal iter (web_fetch only / errors only): increment streak.
    nonTerminalStreak++;
    messages.push({ role: "user", content: toolResults });
  }

  return {
    hypothesis: opts.hypothesis,
    proposed_entity,
    matched_existing_entity_id,
    narrative,
    iteration_log,
    tool_log,
    llm_cost: totalLlmCost.toFixed(6),
    stop_reason,
  };
}

// ---------------------------------------------------------------------------
// System prompt + initial user message
// ---------------------------------------------------------------------------

function buildDiscoverSystem(opts: DiscoverEntityOptions): string {
  const lines: string[] = [];
  lines.push("# tick discover-entity sub-agent");
  lines.push("");
  lines.push(
    "You are a bounded research sub-agent invoked by the parent curate loop. Your job: investigate ONE hypothesized entity and decide whether to add it to the dataset, match it to an existing entity, or reject it.",
  );
  lines.push("");
  lines.push("## Loop shape");
  lines.push("");
  lines.push("1. Read the hypothesis. If seed URLs were provided, fetch them first.");
  if (opts.catalog) {
    lines.push("2. **FIRST: try `catalog_search(capability)`** — for entity discovery, capabilities like `web-search`, `enrich`, `social`, `markets` find paid descriptors that return structured first-class data (no summarizer dropping fields). Call `tool_invoke(id, args)` on the top match. This is faster + cleaner than guessing URLs to `web_fetch`.");
    lines.push("3. **Only fall back to `web_fetch(url)`** when catalog yields zero hits for your needed capability, or when the seed URLs already point at the canonical source (e.g. a specific GitHub repo).");
  } else {
    lines.push("2. Use `web_fetch(url)` to verify the entity exists and gather field values. Each page is auto-summarized to ~500-2000 tokens before you see it.");
  }
  lines.push("3. **Commit by iter 3.** After 1-2 fetches that confirm the entity, propose. You do NOT need 3+ corroborating sources.");
  lines.push("4. Call exactly ONE terminal tool:");
  lines.push("   - `propose_new_entity(entity_id, facts[], narrative)` — add it (terminal)");
  lines.push("   - `propose_match_existing(entity_id, narrative)` — already in dataset under this id (terminal)");
  lines.push("   - `no_match(narrative)` — hypothesis was wrong or out of scope (terminal)");
  lines.push("");
  if (opts.catalog) {
    lines.push("### Probe results from `tool_invoke`");
    lines.push("");
    lines.push("On failure the result contains a `Parsed hints:` block. If `retryable: true`, fix args and retry the same descriptor once. If `retryable: false` (`payment_unhandled`, `not_found`, `auth_required`, `server_error`), don't retry — pick another descriptor via `catalog_search` (different capability or different provider) or fall back to `web_fetch`.");
    lines.push("");
  }
  lines.push("## When to propose vs reject");
  lines.push("");
  lines.push("**Propose new entity when:**");
  lines.push("- You've fetched at least one source that confirms the entity exists");
  lines.push("- You have a citable value (with excerpt) for at least the schema's required fields");
  lines.push("- The entity isn't already in known_entity_ids (see below)");
  lines.push("");
  lines.push("That's enough. Confidence ≠ certainty. A second fetch is for *resolving contradictions*, not for *building confidence in something already corroborated*. If your first fetch produced clean field values that fit the schema, propose — don't fetch a third source to feel more sure.");
  lines.push("");
  lines.push("**Reject (no_match) immediately when:**");
  lines.push("- All seed URLs returned 404 / off-topic → call `no_match` THIS iter. Do not pivot to a different entity or search elsewhere — that's the parent agent's job, not yours. Your job is to investigate THIS hypothesis. If its seed URLs failed, the hypothesis is unverified, call no_match.");
  lines.push("- A fetched source explicitly contradicts the hypothesis (wrong author, wrong domain, repository deleted).");
  lines.push("- The entity is genuinely out of scope for the schema.");
  lines.push("");
  lines.push("Diagnostic check before each fetch: \"Am I about to fetch something to verify my current hypothesis, or am I trying to find a different entity from scratch?\" If the latter, stop — call `no_match` and let the parent re-plan with a new hypothesis. The sub-loop is for verification, not exploration.");
  lines.push("");
  lines.push("## Hard rules");
  lines.push("");
  lines.push("- Every proposed fact MUST cite a `source.url` you actually fetched in this sub-loop.");
  lines.push("- `source.retrieved_at` MUST be the timestamp the page was fetched.");
  lines.push("- `source.excerpt` SHOULD be a verbatim quote (≤2 sentences) supporting the value.");
  lines.push("- NEVER fabricate. If you cannot find a primary source, call `no_match`.");
  lines.push("- The proposed `entity_id` MUST NOT match any of the known_entity_ids below. If your investigation reveals a match, call `propose_match_existing` instead.");
  lines.push("- Do NOT fetch a third source just to feel more confident. Two confirming sources is more than enough; one is usually enough.");
  lines.push("");
  lines.push("## Schema");
  lines.push("");
  lines.push(`Dataset: \`${opts.schema.name}\`${opts.schema.entity_type ? ` (entities are ${opts.schema.entity_type})` : ""}`);
  if (opts.schema.description) lines.push(`Description: ${opts.schema.description}`);
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
  if (opts.fields_to_find && opts.fields_to_find.length > 0) {
    lines.push("## Focus");
    lines.push("");
    lines.push(`The parent wants you to gather these fields if the entity is real: ${opts.fields_to_find.join(", ")}.`);
    lines.push("");
  }
  lines.push("## Known entity_ids (already in the dataset)");
  lines.push("");
  if (opts.known_entity_ids.length === 0) {
    lines.push("(dataset is empty — every viable candidate is a new entity)");
  } else {
    const preview = opts.known_entity_ids.length > 50
      ? `${opts.known_entity_ids.slice(0, 50).join(", ")} … (+${opts.known_entity_ids.length - 50} more)`
      : opts.known_entity_ids.join(", ");
    lines.push(preview);
  }
  lines.push("");
  lines.push(`## Budget`);
  lines.push(`You have **$${opts.budget ?? "0.30"} USDC** for LLM tokens + paid tool calls. Tight; decide fast.`);

  return lines.join("\n");
}

function buildInitialUserText(opts: DiscoverEntityOptions): string {
  const lines: string[] = [];
  lines.push(`Investigate this hypothesis: **${opts.hypothesis}**`);
  if (opts.seed_urls && opts.seed_urls.length > 0) {
    lines.push("");
    lines.push("Seed URLs the parent identified as relevant — start by fetching one of these:");
    for (const u of opts.seed_urls) {
      lines.push(`- ${u}`);
    }
  }
  return lines.join("\n");
}

function extractText(content: LlmContent[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
