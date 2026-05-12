// Web-fetch summarization — the single biggest cost lever in tick.
//
// Problem: web_fetch results land in the agent's context as raw HTML (capped
// at 64 KB). On a curate run, the agent fetches 5-10 pages → context grows
// to 200K+ tokens → every subsequent LLM call costs $0.40-$0.60 just to feed
// Claude the same noise over and over. iter 4 of a real run jumped from 13K
// to 97K tokens in one go (live-confirmed 2026-05-12).
//
// Fix: pipe the raw HTML through a *cheap* LLM (Haiku ~$1/$5 per 1M tok, or
// Workers AI Llama at fractional cents) that extracts ONLY the facts
// relevant to the dataset's schema. The expensive flagship model then
// reasons over a 500-token JSON extract instead of 60 KB of HTML.
//
// Cost cut on a 5-fetch curate run: ~$3.00 → ~$0.30. Single biggest ROI
// architectural change since v0.0.10's budget guard.

import type { FrameSchema } from "../frame-client";
import type { LlmClient } from "./client";

export interface SummarizeOptions {
  /** The raw HTML / text body from the refetcher. */
  body: string;
  /** Frame schema — tells the summarizer which fields to extract. */
  schema: FrameSchema;
  /** Optional entity hint when the caller knows which entity this page is about. */
  entity_hint?: string;
  /** Source URL (kept verbatim in the summary header). */
  source_url: string;
  /** Final URL after redirects (when different). */
  final_url?: string;
  /** LLM client for the cheap-model call. */
  llm: LlmClient;
  /** Hard cap on input to the summarizer (chars, not tokens). Default 32 KB. */
  max_input_chars?: number;
}

export interface SummarizeResult {
  /** Compact text the agent sees instead of raw HTML. ~500-2000 tokens. */
  summary: string;
  /** Tokens used by the summarizer call (added to the run's LLM cost). */
  cost: string;
  /** Whether the summarizer ran successfully. False → caller should use a body excerpt fallback. */
  ok: boolean;
}

/**
 * Run a single Haiku-tier LLM call to extract schema-relevant facts from a
 * fetched page. The summary is structured (sourced excerpts per field)
 * rather than free-form, so the flagship model can cite it in `facts.set_many`
 * events without re-reading the original HTML.
 *
 * Falls back to a raw-body excerpt when the LLM call fails — better to give
 * the agent something than nothing.
 */
export async function summarizeForContext(opts: SummarizeOptions): Promise<SummarizeResult> {
  const maxInput = opts.max_input_chars ?? 32 * 1024;
  const truncated = opts.body.length > maxInput ? opts.body.slice(0, maxInput) : opts.body;
  const schemaFields = Object.entries(opts.schema.fields).map(([name, def]) => {
    const type = (def as { type?: string }).type ?? "string";
    const desc = (def as { description?: string }).description ?? "";
    return `  - ${name} (${type})${desc ? `: ${desc}` : ""}`;
  }).join("\n");

  const system = [
    "You extract schema-relevant facts from web pages for a structured dataset curator.",
    "",
    "Your output is ONLY consumed by another LLM that decides what facts to write to the dataset.",
    "Keep it dense and structured. No flowery prose. No introductions.",
    "",
    "Rules:",
    "1. For every schema field below, if the page mentions a value for it, quote the exact excerpt (≤2 sentences).",
    "2. Note publication / retrieval date if present (used for `last_news_date` style fields).",
    "3. If the page is not relevant to the schema, say so in one line and stop.",
    "4. Never invent or interpolate values.",
    "5. Output ≤500 tokens.",
    "",
    `## Schema (dataset: ${opts.schema.name})`,
    "",
    schemaFields,
  ].join("\n");

  const user = [
    `Source URL: ${opts.source_url}`,
    opts.final_url && opts.final_url !== opts.source_url ? `Final URL after redirects: ${opts.final_url}` : null,
    opts.entity_hint ? `Looking for facts about: ${opts.entity_hint}` : null,
    "",
    "Page content:",
    "",
    truncated,
    opts.body.length > maxInput ? `\n[truncated: page was ${opts.body.length} chars, summarized first ${maxInput}]` : "",
  ].filter(Boolean).join("\n");

  try {
    const res = await opts.llm.call({
      system,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      agent: "title", // cheap model — Haiku in BYOK/marketplace, Llama 3.1 in Workers AI
      max_tokens: 800,
    });
    const summary = extractText(res.content);
    const formatted = [
      `[Summarized from ${opts.final_url ?? opts.source_url}]`,
      summary,
    ].join("\n");
    return { summary: formatted, cost: res.usage.estimated_cost, ok: true };
  } catch (e) {
    // Fallback: give the agent a raw-text excerpt rather than nothing.
    // Stripping HTML tags very rudely keeps the most info-dense bytes.
    const fallback = stripHtmlRough(opts.body).slice(0, 6 * 1024);
    return {
      summary: [
        `[Summarizer failed: ${(e as Error).message}; raw text excerpt below]`,
        `Source: ${opts.source_url}`,
        "",
        fallback,
      ].join("\n"),
      cost: "0",
      ok: false,
    };
  }
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n");
}

/**
 * Quick-and-dirty HTML-tag stripper for the failure fallback path. Not a
 * proper parser — drops `<script>`, `<style>`, then any remaining tags,
 * then collapses whitespace. Good enough for "show the agent SOMETHING
 * useful even if Haiku timed out."
 */
function stripHtmlRough(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
