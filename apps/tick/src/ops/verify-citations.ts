// CitationAgent — post-pass verifier for curate.
//
// The synthesizer that writes facts also picks the cited excerpt. That's
// exactly the configuration Anthropic warns about: a single LLM writes the
// claim AND attaches the citation, so it can fabricate plausible-sounding
// quotes for plausible-sounding values. The fix is a separate pass with
// a different role: given each claim and its quoted excerpt, decide whether
// the excerpt directly supports the claim — nothing else.
//
// **v0.4.2 — batched judgement.** v0.2.0's first cut made one Haiku call
// per fact. On a real curate (15 sub-agents writing 13 events), that fired
// ~13 sequential Haiku calls alongside ~30 summarizer Haiku calls — enough
// to trigger Anthropic 429 "Type 2b rate limited" via the AI Gateway. The
// verifier degraded silently, no facts checked. Live-confirmed 2026-05-13.
//
// Now we batch: one Haiku call per BATCH_SIZE facts, response is a JSON
// array keyed by fact_id. Same trust signal, ~1/15th the call count, no
// rate-limit pressure. Slightly cheaper too (shared prefix, one cached
// system block per batch).
//
// What this does NOT do:
//   - It does NOT re-fetch the source URL. That's the separate `verify` op.
//   - It does NOT verify deprecation reasons; only newly-set facts.

import { randomUUID } from "node:crypto";
import type { FrameEvent } from "@frames-ag/tick-types";
import type { IterationLogEntry } from "@frames-ag/tick-types";
import type { LlmClient } from "../llm/client";

/**
 * Max facts per Haiku call. Above this, we split into multiple batches.
 * Each fact contributes ~30-80 tokens of output (`fact_id`, `supported`,
 * `reason`); 30 facts ≈ 1500 output tokens, comfortable under Haiku's
 * default response budget. Keep small enough that ONE malformed JSON
 * response only loses N facts of verification, not the whole run.
 */
const BATCH_SIZE = 30;

export interface VerifyCitationsOptions {
  /** Events emitted by the parent curate loop. We walk these for facts.set_many / fact.set. */
  events: FrameEvent[];
  llm: LlmClient;
  run_id: string;
  /** Agent identity for any fact.deprecated events we emit. */
  agent: string;
}

export interface VerifyCitationsResult {
  /** Deprecation events to APPEND to the run's events list. */
  deprecation_events: FrameEvent[];
  /** Per-batch verifier LLM calls. Logged for cost attribution. */
  iteration_log: IterationLogEntry[];
  /** Total Haiku cost for this pass (USDC). */
  llm_cost: string;
  /** Summary counts. */
  summary: {
    facts_checked: number;
    supported: number;
    unsupported: number;
    /** Facts that couldn't be checked (missing excerpt). Skipped, not deprecated. */
    skipped_no_excerpt: number;
  };
}

interface FactToVerify {
  fact_id: string;
  entity_id: string;
  field: string;
  value: unknown;
  excerpt: string;
}

export async function verifyCitations(opts: VerifyCitationsOptions): Promise<VerifyCitationsResult> {
  const allFacts = extractFactsFromEvents(opts.events);

  // Filter out facts with no excerpt — can't verify a claim without a quote.
  // Skipped (not deprecated): the gap is surfaced via summary so customers
  // can decide to enforce excerpt presence at curation time.
  const skippable: FactToVerify[] = [];
  const verifiable: FactToVerify[] = [];
  for (const f of allFacts) {
    if (!f.excerpt || f.excerpt.trim().length === 0) {
      skippable.push(f);
    } else {
      verifiable.push(f);
    }
  }

  const iteration_log: IterationLogEntry[] = [];
  let totalCost = 0;
  let supported = 0;
  let unsupported = 0;
  const deprecation_events: FrameEvent[] = [];

  // Process verifiable facts in batches of BATCH_SIZE.
  for (let i = 0; i < verifiable.length; i += BATCH_SIZE) {
    const batch = verifiable.slice(i, i + BATCH_SIZE);
    const judgement = await judgeBatch(opts.llm, batch);
    totalCost += Number(judgement.cost);
    iteration_log.push({
      iter: iteration_log.length + 1,
      model: judgement.model,
      input_tokens: judgement.input_tokens,
      output_tokens: judgement.output_tokens,
      cost: judgement.cost,
      stop_reason: judgement.stop_reason,
      cache_creation_input_tokens: judgement.cache_creation_input_tokens,
      cache_read_input_tokens: judgement.cache_read_input_tokens,
    });

    // Match judgements back to the batch by fact_id. Facts missing from the
    // model's response are conservatively counted as `supported` (graceful
    // degradation — we'd rather false-negative on a verifier miss than
    // surface a spurious deprecation).
    const byFactId = new Map<string, BatchJudgement>();
    for (const j of judgement.judgements) byFactId.set(j.fact_id, j);

    for (const f of batch) {
      const j = byFactId.get(f.fact_id);
      if (!j) {
        // Missing judgement → treat as supported (no deprecation).
        supported++;
        continue;
      }
      if (j.supported) {
        supported++;
        continue;
      }
      unsupported++;
      deprecation_events.push({
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: "fact.deprecated",
        agent: opts.agent,
        run_id: opts.run_id,
        payload: {
          fact_id: f.fact_id,
          reason: `citation_unverified: ${j.reason}`,
        },
      });
    }
  }

  return {
    deprecation_events,
    iteration_log,
    llm_cost: totalCost.toFixed(6),
    summary: {
      facts_checked: verifiable.length,
      supported,
      unsupported,
      skipped_no_excerpt: skippable.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Walk the run's events and pull every fact + its citation.
// ---------------------------------------------------------------------------

function extractFactsFromEvents(events: FrameEvent[]): FactToVerify[] {
  const out: FactToVerify[] = [];
  for (const ev of events) {
    if (ev.type === "facts.set_many") {
      const payload = ev.payload as {
        entity_id?: string;
        facts?: Array<{ fact_id?: string; field?: string; value?: unknown; source?: { excerpt?: string } }>;
      };
      const entity_id = String(payload.entity_id ?? "");
      for (const f of payload.facts ?? []) {
        out.push({
          fact_id: String(f.fact_id ?? ""),
          entity_id,
          field: String(f.field ?? ""),
          value: f.value,
          excerpt: String(f.source?.excerpt ?? ""),
        });
      }
      continue;
    }
    if (ev.type === "fact.set") {
      const payload = ev.payload as {
        fact_id?: string;
        entity_id?: string;
        field?: string;
        value?: unknown;
        source?: { excerpt?: string };
      };
      out.push({
        fact_id: String(payload.fact_id ?? ""),
        entity_id: String(payload.entity_id ?? ""),
        field: String(payload.field ?? ""),
        value: payload.value,
        excerpt: String(payload.source?.excerpt ?? ""),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batched Haiku call: judge N facts in one shot
// ---------------------------------------------------------------------------

interface BatchJudgement {
  fact_id: string;
  supported: boolean;
  reason: string;
}

interface BatchJudgementResult {
  judgements: BatchJudgement[];
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: string;
  stop_reason: string;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

async function judgeBatch(
  llm: LlmClient,
  facts: FactToVerify[],
): Promise<BatchJudgementResult> {
  const system = [
    "You verify that quoted excerpts directly support structured claims about entities.",
    "",
    "For EACH claim below, decide whether the cited excerpt supports the claim's value.",
    "",
    "Output STRICT JSON ONLY, no prose, no markdown fence:",
    '{"judgements": [{"fact_id": "<id>", "supported": true|false, "reason": "<≤1 sentence>"}, ...]}',
    "",
    "Rules:",
    "- A claim is supported only if the excerpt explicitly states or unambiguously implies the value.",
    "- Numerical mismatches → unsupported (exact match required for ints/floats/percentages).",
    "- For STRING values, semantic equivalence counts. Examples that ARE supported:",
    "  · excerpt 'MCP server framework' supports value 'framework' (the field is `category`).",
    "  · excerpt 'name: mcp-jetbrains' inside a JetBrains/ repo path supports value 'JetBrains/mcp-jetbrains'.",
    "  · truncated excerpt where the visible portion clearly supports the value (the truncation is the harness's, not the source's fault).",
    "- Vague paraphrase that doesn't pin the exact value → unsupported.",
    "- Empty / generic excerpts that say nothing about the field → unsupported.",
    "- Don't reject for missing parenthetical asides or extra qualifiers — judge whether the CORE claim is supported.",
    "- Be strict on numbers and identifiers; be reasonable on prose. False positives erode dataset trust, but rejecting semantically-correct facts wastes the agent's work.",
    "- The output array MUST contain exactly one entry per fact_id in the input. Use the exact fact_id string for each.",
  ].join("\n");

  const user = [
    `Verify each claim below (${facts.length} total):`,
    "",
    ...facts.map((f, idx) =>
      [
        `${idx + 1}. fact_id="${f.fact_id}", entity="${f.entity_id}", field="${f.field}", value=${jsonish(f.value)}`,
        `   excerpt: """${f.excerpt}"""`,
      ].join("\n"),
    ),
  ].join("\n");

  // Output token budget: roughly 50 tokens per fact (fact_id + supported +
  // reason), plus ~30 for the wrapper. Pad generously to avoid truncation.
  const max_tokens = Math.min(8192, 200 + facts.length * 80);

  const res = await llm.call({
    system,
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    agent: "title", // Haiku tier
    max_tokens,
  });

  const text = extractText(res.content);
  const judgements = parseBatchJudgements(text, facts);

  return {
    judgements,
    model: res.model,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cost: res.usage.estimated_cost,
    stop_reason: res.stop_reason,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens,
    cache_read_input_tokens: res.usage.cache_read_input_tokens,
  };
}

/**
 * Parse Haiku's batched response. Tolerant: handles code-fence wrapping,
 * extra prose before/after the JSON, and missing entries. Returns whatever
 * judgements we can match by fact_id; missing facts are handled by the
 * caller (treated as supported, no deprecation).
 */
export function parseBatchJudgements(
  rawText: string,
  facts: FactToVerify[],
): BatchJudgement[] {
  const factIds = new Set(facts.map((f) => f.fact_id));

  // Strip code fence if present.
  let stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Try strict parse first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to recover by finding the first { and last } in the text.
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as { judgements?: unknown };
  if (!Array.isArray(root.judgements)) return [];

  const out: BatchJudgement[] = [];
  for (const entry of root.judgements) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { fact_id?: unknown; supported?: unknown; reason?: unknown };
    const factId = typeof e.fact_id === "string" ? e.fact_id : "";
    if (!factId || !factIds.has(factId)) continue;
    out.push({
      fact_id: factId,
      supported: e.supported === true,
      reason:
        typeof e.reason === "string" && e.reason.length > 0
          ? e.reason.slice(0, 200)
          : "unverified",
    });
  }
  return out;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n");
}

function jsonish(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
