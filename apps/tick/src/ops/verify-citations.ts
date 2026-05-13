// CitationAgent — post-pass verifier for curate.
//
// The synthesizer that writes facts also picks the cited excerpt. That's
// exactly the configuration Anthropic warns about: a single LLM writes the
// claim AND attaches the citation, so it can fabricate plausible-sounding
// quotes for plausible-sounding values. The fix is a separate pass with
// a different role: given a claim and its quoted excerpt, decide whether
// the excerpt directly supports the claim — nothing else.
//
// Cheap by design: Haiku-tier ("agent: title") with ~130 in / 30 out tokens
// per fact. At $1/$5 per 1M tokens that's ~$0.0003 / fact. For a 20-fact
// curate run, the entire verification pass runs at ~$0.006 — well under
// the cost of a single tool fetch.
//
// What this does NOT do:
//   - It does NOT re-fetch the source URL. That would be a separate
//     "strict" mode; not in v0.2.0. Today we only check that the cited
//     excerpt logically supports the claim. The agent could in principle
//     fabricate the excerpt itself — that's caught by `verify` op, not here.
//   - It does NOT verify deprecation reasons; only newly-set facts.

import { randomUUID } from "node:crypto";
import type { FrameEvent } from "@frames-ag/tick-types";
import type { IterationLogEntry } from "@frames-ag/tick-types";
import type { LlmClient } from "../llm/client";

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
  /** Per-fact verifier LLM calls. Logged for cost attribution. */
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
  const facts = extractFactsFromEvents(opts.events);
  const iteration_log: IterationLogEntry[] = [];
  let totalCost = 0;
  let supported = 0;
  let unsupported = 0;
  let skipped = 0;
  const deprecation_events: FrameEvent[] = [];

  for (const f of facts) {
    if (!f.excerpt || f.excerpt.trim().length === 0) {
      // Can't verify a claim without a quote. Don't deprecate; surface the
      // gap separately via the summary so customers can decide to enforce
      // excerpt presence at curation time.
      skipped++;
      continue;
    }

    const judgement = await judgeOne(opts.llm, f);
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

    if (judgement.supported) {
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
        reason: `citation_unverified: ${judgement.reason}`,
      },
    });
  }

  return {
    deprecation_events,
    iteration_log,
    llm_cost: totalCost.toFixed(6),
    summary: {
      facts_checked: facts.length - skipped,
      supported,
      unsupported,
      skipped_no_excerpt: skipped,
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
// Single Haiku call: does this excerpt support this claim?
// ---------------------------------------------------------------------------

interface JudgementResult {
  supported: boolean;
  reason: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: string;
  stop_reason: string;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

async function judgeOne(llm: LlmClient, f: FactToVerify): Promise<JudgementResult> {
  const system = [
    "You verify that a quoted excerpt directly supports a structured claim about an entity.",
    "",
    "Output STRICT JSON ONLY, no prose, no markdown fence:",
    '{"supported": true|false, "reason": "≤1 sentence"}',
    "",
    "Rules:",
    "- A claim is supported only if the excerpt explicitly states or unambiguously implies the value.",
    "- Numerical mismatches → unsupported.",
    "- Vague paraphrase that doesn't pin the exact value → unsupported.",
    "- Empty / generic excerpts that say nothing about the field → unsupported.",
    "- Be strict. False positives erode dataset trust more than false negatives.",
  ].join("\n");

  const user = [
    `Claim: entity \`${f.entity_id}\`, field \`${f.field}\` = ${jsonish(f.value)}`,
    `Cited excerpt: """${f.excerpt}"""`,
  ].join("\n");

  const res = await llm.call({
    system,
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    agent: "title", // Haiku tier — same as the HTML summarizer in summarize.ts
    max_tokens: 120,
  });

  const text = extractText(res.content);
  let supported = false;
  let reason = "unverified";
  try {
    const parsed = JSON.parse(text.trim()) as { supported?: unknown; reason?: unknown };
    supported = parsed.supported === true;
    if (typeof parsed.reason === "string" && parsed.reason.length > 0) {
      reason = parsed.reason.slice(0, 200);
    }
  } catch {
    // Fallback parser: cheap models occasionally wrap JSON in a code fence or
    // add a leading sentence. Treat any "supported": true | "yes" / "no"
    // signal in the raw text.
    if (/"supported"\s*:\s*true/i.test(text) || /^\s*(yes|supported)\b/i.test(text)) {
      supported = true;
    }
    const reasonMatch = text.match(/"reason"\s*:\s*"([^"]{1,200})"/);
    if (reasonMatch) reason = reasonMatch[1]!;
  }

  return {
    supported,
    reason,
    model: res.model,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cost: res.usage.estimated_cost,
    stop_reason: res.stop_reason,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens,
    cache_read_input_tokens: res.usage.cache_read_input_tokens,
  };
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
