// Web-fetch summarization — the single biggest cost lever in tick.
//
// Problem (v0.0.13): web_fetch results land in the agent's context as raw HTML
// (capped at 64 KB). On a curate run, the agent fetches 5-10 pages → context
// grows to 200K+ tokens → every subsequent LLM call costs $0.40-$0.60 just to
// feed Claude the same noise over and over.
//
// Fix (v0.0.13): pipe the raw HTML through a *cheap* LLM (Haiku) that extracts
// ONLY the facts relevant to the dataset's schema. The expensive flagship
// model then reasons over a compressed extract instead of 60 KB of HTML.
//
// Generalization (v0.3.13): the original implementation asked Haiku for
// PROSE excerpts ("FastMCP is a Python framework..."). That's fine for
// narrative facts but throws away numeric / structured values (star counts,
// dates, enum codes) — the very fields the agent needs to cite verbatim
// into `facts.set_many` events. Live diagnostic data on 2026-05-13 showed
// refresh sub-loops failing because Haiku dropped the values they were
// looking for, forcing redundant second fetches.
//
// New shape: Haiku returns STRUCTURED JSON, one entry per schema field,
// with `{ value, excerpt }` (or `null` when the field isn't in the source).
// The agent gets directly-citable data; no "I lost the stars count, let me
// re-fetch" pattern. Works uniformly for HTML pages AND structured API
// responses — Haiku does the per-field mapping in both cases.

import type { FrameSchema } from "../frame-client";
import type { LlmClient } from "./client";

export interface SummarizeOptions {
  /** The raw HTML / JSON / text body from the refetcher. */
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

/**
 * Per-field extraction result from Haiku. `null` means the field was not
 * found in the source — the agent should NOT treat absence as a value.
 */
export interface ExtractedField {
  /** The literal value Haiku saw in the source (number, string, boolean, etc). */
  value: unknown;
  /**
   * Verbatim excerpt from the source supporting `value`. ≤2 sentences.
   * Cited directly into `source.excerpt` when the agent writes a fact.
   */
  excerpt: string;
}

export interface ExtractedFields {
  /** Map of schema field name → extraction (or null when not found). */
  fields: Record<string, ExtractedField | null>;
  /**
   * Optional free-form note from Haiku — e.g., "page is a 404" or
   * "source mentions the entity but no field values are visible".
   * Surfaced to the agent so it can decide whether to retry or skip.
   */
  notes?: string;
}

export interface SummarizeResult {
  /**
   * Markdown-rendered version of `extracted` — the string the agent
   * actually sees as the `web_fetch` tool_result content. Public surface
   * for back-compat with callers that just splice the summary into
   * messages. Always non-empty (even fallback path produces something).
   */
  summary: string;
  /** Structured extraction, when Haiku produced valid JSON. */
  extracted?: ExtractedFields;
  /** Tokens used by the summarizer call (added to the run's LLM cost). */
  cost: string;
  /** True when structured extraction succeeded; false on fallback path. */
  ok: boolean;
}

/**
 * Extract schema-relevant facts from a fetched page using Haiku-tier LLM,
 * producing structured per-field output the agent can cite directly.
 *
 * Returns `summary` as a rendered string for backward compatibility with
 * call sites that splice into messages, AND `extracted` as the structured
 * data for callers that want to consume fields programmatically.
 *
 * Falls back to a raw-text excerpt if Haiku fails or returns malformed
 * JSON. Fallback never throws; the agent always gets something to work
 * with even if it's lower-quality.
 */
export async function summarizeForContext(opts: SummarizeOptions): Promise<SummarizeResult> {
  const maxInput = opts.max_input_chars ?? 32 * 1024;
  const truncated = opts.body.length > maxInput ? opts.body.slice(0, maxInput) : opts.body;
  const schemaFields = Object.entries(opts.schema.fields).map(([name, def]) => {
    const type = (def as { type?: string }).type ?? "string";
    const desc = (def as { description?: string }).description ?? "";
    const enumVals = (def as { values?: string[] }).values;
    const enumPart = enumVals ? ` ∈ {${enumVals.join(", ")}}` : "";
    return `  - ${name} (${type}${enumPart})${desc ? `: ${desc}` : ""}`;
  }).join("\n");

  const fieldKeys = Object.keys(opts.schema.fields);

  const system = [
    "You extract schema-relevant facts from web pages or API responses for a structured dataset curator.",
    "",
    "Output STRICT JSON ONLY. No prose, no markdown fence, no commentary.",
    "Schema:",
    '  { "fields": { "<field_name>": { "value": <typed value>, "excerpt": "<verbatim ≤2 sentence quote>" } | null, ... }, "notes": "<optional, single line>" }',
    "",
    "Rules:",
    "1. For every schema field listed below, emit an entry — either { value, excerpt } when the source supports the field, OR null when the source does not mention a value for it.",
    "2. `value` MUST be the typed value (number for int/float fields, string for string/url/date fields, boolean for bool fields). Do not wrap numbers in quotes. For enums, output the enum string.",
    "3. `excerpt` MUST be a verbatim quote from the source supporting `value` (≤2 sentences, ≤200 chars).",
    "4. NEVER invent or interpolate values. If you cannot find a primary citation for a field, return null for that field.",
    "5. For structured API responses (JSON), `value` is the raw JSON value; `excerpt` is the relevant JSON fragment as a string.",
    "6. `notes` is optional — use it for context the agent should know (e.g., '404 page', 'entity mentioned but no values visible', 'page is a list of unrelated entities').",
    "",
    `## Schema (dataset: ${opts.schema.name})`,
    "",
    schemaFields,
    "",
    "## Required keys in your output",
    "",
    `Your "fields" object MUST contain every one of these keys: ${fieldKeys.join(", ")}. Use null for fields not found.`,
  ].join("\n");

  const user = [
    `Source URL: ${opts.source_url}`,
    opts.final_url && opts.final_url !== opts.source_url ? `Final URL after redirects: ${opts.final_url}` : null,
    opts.entity_hint ? `Looking for facts about: ${opts.entity_hint}` : null,
    "",
    "Source content:",
    "",
    truncated,
    opts.body.length > maxInput ? `\n[truncated: source was ${opts.body.length} chars, extracted first ${maxInput}]` : "",
  ].filter(Boolean).join("\n");

  try {
    const res = await opts.llm.call({
      system,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      agent: "title",
      max_tokens: 1200,
    });
    const rawText = extractText(res.content);
    const parsed = tryParseExtraction(rawText, fieldKeys);
    if (!parsed) {
      // Haiku returned non-JSON or shape mismatch. Surface the raw text as
      // the fallback "summary" so the agent still sees SOMETHING, but mark
      // ok=false so callers can detect degradation.
      return {
        summary: [
          `[Summarized from ${opts.final_url ?? opts.source_url} — structured parse failed; raw extract below]`,
          rawText.slice(0, 4000),
        ].join("\n"),
        cost: res.usage.estimated_cost,
        ok: false,
      };
    }
    return {
      summary: renderExtraction(opts, parsed),
      extracted: parsed,
      cost: res.usage.estimated_cost,
      ok: true,
    };
  } catch (e) {
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

// ---------------------------------------------------------------------------
// Parsing + rendering
// ---------------------------------------------------------------------------

/**
 * Parse Haiku's output as JSON, validate the `fields` shape, and ensure
 * every schema field is represented. Returns null if any of these checks
 * fail — the caller falls back to surfacing the raw text.
 *
 * Tolerant: accepts the JSON wrapped in a code fence (```json ... ```).
 * Strict on field-presence: Haiku must emit a key for every schema field.
 */
export function tryParseExtraction(rawText: string, fieldKeys: string[]): ExtractedFields | null {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const root = obj as { fields?: unknown; notes?: unknown };
  if (!root.fields || typeof root.fields !== "object") return null;
  const rawFields = root.fields as Record<string, unknown>;

  const fields: Record<string, ExtractedField | null> = {};
  for (const key of fieldKeys) {
    const entry = rawFields[key];
    if (entry === null || entry === undefined) {
      fields[key] = null;
      continue;
    }
    if (typeof entry !== "object") {
      // Haiku put a bare value with no excerpt — treat as null.
      fields[key] = null;
      continue;
    }
    const obj = entry as { value?: unknown; excerpt?: unknown };
    if (obj.value === undefined) {
      fields[key] = null;
      continue;
    }
    const excerpt = typeof obj.excerpt === "string" ? obj.excerpt.slice(0, 400) : "";
    fields[key] = { value: obj.value, excerpt };
  }

  const notes = typeof root.notes === "string" && root.notes.length > 0
    ? root.notes.slice(0, 500)
    : undefined;

  return { fields, notes };
}

/**
 * Render structured extraction back to the markdown-ish text the agent
 * sees as the web_fetch tool_result. Includes the source URL header so
 * the agent can cite. Field rows are denser than v0.0.13's prose — about
 * 1 line per field — but the structured form means the agent can paste
 * the value directly into a fact without re-parsing.
 */
function renderExtraction(opts: SummarizeOptions, extracted: ExtractedFields): string {
  const lines: string[] = [];
  lines.push(`[Source: ${opts.final_url ?? opts.source_url}]`);
  if (opts.final_url && opts.final_url !== opts.source_url) {
    lines.push(`[Original: ${opts.source_url}]`);
  }
  if (opts.entity_hint) {
    lines.push(`[Entity: ${opts.entity_hint}]`);
  }
  lines.push("");
  lines.push("Fields extracted:");
  for (const [name, entry] of Object.entries(extracted.fields)) {
    if (entry === null) {
      lines.push(`  - ${name}: (not found in source)`);
    } else {
      const valueStr = renderValue(entry.value);
      const excerpt = entry.excerpt ? ` ← "${entry.excerpt}"` : "";
      lines.push(`  - ${name}: ${valueStr}${excerpt}`);
    }
  }
  if (extracted.notes) {
    lines.push("");
    lines.push(`Notes: ${extracted.notes}`);
  }
  return lines.join("\n");
}

function renderValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
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
