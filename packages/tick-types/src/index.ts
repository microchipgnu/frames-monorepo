// Shared types for tick (frame runtime) and frames-cloud.
// Wire formats live here so consumers don't need to depend on the runtime app.

/**
 * Source attribution shape — mirrors frame protocol's `Source` type. Every fact
 * cites at least one. See packages/frame/PROTOCOL.md § Source schema.
 */
export interface Source {
  url: string;
  retrieved_at: string;
  title?: string;
  archive_url?: string;
  excerpt?: string;
  /** Optional link to a `tool.invoked` receipt that produced this URL. */
  receipt_id?: string;
}

/**
 * The four operations tick exposes. Each maps to a frame-shaped agent loop.
 *
 *   curate    — full agent loop: read state, search sources, write facts, verify
 *   refresh   — re-fetch every existing fact's source.url; deprecate dead sources
 *   verify    — read-only: re-fetch sources and compare. Reports drift; no writes
 *   discover  — search-only; propose candidate entities; writes go to review queue
 */
export type Op = "curate" | "refresh" | "verify" | "discover";

/**
 * Request body for POST /run on tick.frames.ag.
 *
 * Auth is via x402 signature in the PAYMENT-SIGNATURE header (not in the body),
 * verified by the Faremeter facilitator. The wallet_sig field below is the
 * SIWX session token for free read endpoints (status, history, balance).
 */
export interface RunInput {
  op: Op;
  /** GitHub URL of the frame: https://github.com/<user>/<repo>[/<path>] */
  frame: string;
  /** Upper-bound budget for the run, in USDC. Settled actual via x402 `upto`. */
  budget: string;
  /** SIWX session token. Optional for /run (x402 sig is authoritative); required for read endpoints. */
  wallet_sig?: string;
  /** Op-specific params (e.g., refresh: which fields; discover: capability hints). */
  params?: Record<string, unknown>;
}

/**
 * Response body for POST /run.
 *
 * The events array contains newly-written `events.ndjson` lines the caller
 * should append to their frame. `run_id` keys to the receipt at GET /runs/<id>.
 */
export interface RunResult {
  run_id: string;
  op: Op;
  frame: string;
  /** USDC actually settled (≤ budget). */
  settled: string;
  /** Frame events written during this run, in order. Append to events.ndjson. */
  events: FrameEvent[];
  /** Tool calls made during the run. Sources cited by events resolve here by source_url. */
  tool_log: ToolCall[];
  /** Free-form summary the agent produced. */
  summary: string;
  /**
   * The model's own one-paragraph wrap-up of what it did, what it found,
   * and what it recommends next. The single most human-readable output of
   * any run. Null when no LLM was involved (verify / refresh) or no LLM
   * call completed. Customers should display this prominently.
   */
  narrative?: string | null;
  /**
   * One entry per LLM call across the agent loop. Lets customers see exactly
   * where their budget went — which iter, which model, how many tokens, how
   * much each call cost, what stopped the call. Empty array for non-LLM ops
   * (verify, refresh).
   */
  iteration_log?: IterationLogEntry[];
  /**
   * Sub-agent runs spawned during this run (one per `refresh_entity` tool
   * call). Each is its own bounded loop with its own iteration_log. Empty
   * for ops that don't invoke sub-agents (verify, refresh, discover).
   */
  sub_runs?: SubRunSummary[];
  /** ISO 8601 wall-clock duration boundaries. */
  started_at: string;
  ended_at: string;
}

/**
 * Surface shape of a sub-agent run in the parent's RunResult. Mirrors
 * `apps/tick/src/ops/types.ts:SubRun` but lives here so downstream
 * consumers can read it via `@frames-ag/tick-types` without depending on
 * the runtime's internal types.
 */
export interface SubRunSummary {
  entity_id: string;
  action: "facts_set" | "deprecated" | "no_change" | "no_op";
  stop_reason: string;
  facts_set: number;
  deprecations: number;
  iterations: number;
  iteration_log: IterationLogEntry[];
  llm_cost: string;
  narrative: string;
}

export interface IterationLogEntry {
  /** 1-indexed agent-loop iteration. */
  iter: number;
  /** Model string the call was routed to (e.g. `anthropic/claude-sonnet-4-6`). */
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** USDC cost of this single call. */
  cost: string;
  /** Anthropic-style stop reason: end_turn / tool_use / max_tokens / budget_exhausted / ... */
  stop_reason: string;
  /**
   * Tokens written to the prompt cache on this call (Anthropic ephemeral cache).
   * Set on the first iter of a sub-loop or parent; zero/undefined thereafter.
   * Cost is 1.25× input rate for these tokens.
   */
  cache_creation_input_tokens?: number;
  /**
   * Tokens read from the prompt cache. Zero on first iter, then ~size of
   * the cached system+tools prefix on subsequent iters. Cost is 0.10× input
   * rate for these — the savings live here.
   */
  cache_read_input_tokens?: number;
}

/**
 * Frame event envelope. Mirrors packages/frame's PROTOCOL.md plus the queued
 * v0.0.2 `run_id` field that tick contributes upstream.
 *
 * Type-specific payload shapes are intentionally `unknown` here — the consumer
 * should validate against the frame protocol spec, not against tick's types.
 */
export interface FrameEvent {
  id: string; // UUID v4
  ts: string; // ISO 8601
  type:
    | "entity.created"
    | "fact.set"
    | "facts.set_many"      // v0.2.0+ atomic bulk write
    | "fact.deprecated"
    | "evidence.attached"
    | "entity.removed"
    | "tool.invoked";       // emitted by pay when a paid call fires
  agent: string; // e.g. "frames-runtime:<wallet-address>"
  run_id: string; // v0.2.0 field
  payload: unknown;
}

/**
 * One paid (or free) tool call made during the run, as it appears in the
 * receipt. The source_url here is the canonical source attribution for any
 * frame facts that cite it.
 */
export interface ToolCall {
  /** descriptor_id from the catalog (SHA-256 of canonical JSON). */
  descriptor_id: string;
  /** Human-readable id from the catalog (e.g., "search.exa"). */
  tool_id: string;
  /** Settled cost in USDC. Zero for free APIs (GitHub, Polymarket public, etc.). */
  cost: string;
  /** Source URL returned by the tool — what facts cite. */
  source_url?: string;
  /** ISO 8601. */
  retrieved_at: string;
  /** SHA-256 of canonical input JSON, for replay & dedup. */
  input_hash: string;
}

/**
 * Receipt returned by GET /runs/<run_id>.
 * SIWX-gated; the wallet that signed /run can fetch this for free.
 */
export interface RunReceipt {
  run_id: string;
  op: Op;
  frame: string;
  /** Identity that signed the original /run call. */
  agent: string;
  /** Total settled USDC. */
  settled: string;
  events: FrameEvent[];
  tool_log: ToolCall[];
  summary: string;
  started_at: string;
  ended_at: string;
  /** Cloudflare-side metadata: which colo handled the run, run ID for audit. */
  region?: string;
}

/**
 * Default `upto` budgets per op. Customers can override per-call. Sourced from
 * real-workload analysis (frames-examples + blindspot.news logs, May 2026):
 *
 *   curate: P50 $0.50, P95 $1.80   → default ceiling $1.50
 *   refresh: P50 $0.10, P95 $0.25  → default ceiling $0.30
 *   verify: P50 $0.05, P95 $0.12   → default ceiling $0.15
 *   discover: P50 $0.15, P95 $0.45 → default ceiling $0.50
 */
/**
 * Defaults bumped 2026-05-12 after a real curate run blew $1.40 of LLM tokens
 * against the prior $1.50 ceiling and produced 0 events. With Claude Sonnet 4.6
 * via CF marketplace at $3/$15 per 1M tokens, a 5-iter curate over a 13-entity
 * frame floors at ~$1.20 in LLM cost alone — leaving zero room for paid tool
 * calls. New defaults assume LLM tokens + a modest paid-tool buffer.
 */
export const DEFAULT_BUDGETS: Record<Op, string> = {
  curate: "3.00",
  refresh: "0.50",
  verify: "0.15",
  discover: "1.50",
};
