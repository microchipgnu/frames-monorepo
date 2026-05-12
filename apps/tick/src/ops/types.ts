// Shared types for op implementations.

import type { FrameEvent, RunResult, ToolCall } from "@frames-ag/tick-types";

/**
 * Single drift finding produced by a verify op. Multiple drifts per entity/field
 * are possible (e.g., source dead AND value mismatch on a corroborating source).
 */
export interface Drift {
  entity_id: string;
  field: string;
  /**
   *   source_dead       — URL returns 4xx/5xx, network error, or timeout
   *   value_drift       — URL still resolves but no longer supports the current value
   *   excerpt_missing   — recorded excerpt no longer appears in the source body
   *   source_redirect   — URL now redirects to a different page (potential link rot)
   *   verified          — source still supports the value (recorded for completeness, ignored by default)
   */
  kind: "source_dead" | "value_drift" | "excerpt_missing" | "source_redirect" | "verified";
  url: string;
  current_value: unknown;
  /** When `kind === "source_dead"`, the underlying error. */
  error?: string;
  /** When `kind === "source_redirect"`, the destination. */
  redirect_to?: string;
  /** When `kind === "excerpt_missing"`, the original excerpt the agent recorded. */
  original_excerpt?: string;
}

/**
 * Pluggable source-refetcher. Default implementation (week 2) routes through
 * pay.Wallet + the catalog; tests can substitute a deterministic stub.
 */
export type Refetcher = (input: {
  url: string;
  /** Token budget remaining (USDC). Refetcher should abort if cost would exceed. */
  remaining_budget: string;
  /** run_id propagated to any emitted tool.invoked event. */
  run_id: string;
}) => Promise<RefetchResult>;

export interface RefetchResult {
  /** True if the URL resolved with a 2xx response. */
  ok: boolean;
  /** Final URL after any redirects. */
  final_url: string;
  /** Decoded body as text (caller checks excerpt presence here). */
  body?: string;
  /** Bytes transferred; informational. */
  body_bytes?: number;
  /** Error message when ok=false. */
  error?: string;
  /** The tool.invoked event the runtime should append to the frame's events.ndjson. */
  event?: FrameEvent;
  /** The corresponding tool_log row for the receipt. */
  tool_call?: ToolCall;
}

/**
 * Common shape every op implementation returns. The Hono handler wraps this
 * with the wire-level RunResult fields (started_at, ended_at, settled).
 */
export interface OpOutcome {
  events: FrameEvent[];
  tool_log: ToolCall[];
  summary: string;
  /** Per-LLM-call entries from the agent loop. Empty for non-LLM ops. */
  iteration_log?: import("@frames-ag/tick-types").IterationLogEntry[];
  /** Sub-agent runs (one per `refresh_entity` call). Each is a bounded loop with its own iteration_log. */
  sub_runs?: SubRun[];
  /** Op-specific structured payload (e.g., verify returns Drift[]). */
  report?: Record<string, unknown>;
}

/**
 * Result of an LLM-tool dispatch (curate / discover agent loops).
 *
 * `result_text` feeds the LLM as the tool_result content. `events` are frame
 * events emitted by the tool (e.g. add_entity_with_facts produces one);
 * `tool_call` is the receipt row for paid invocations.
 */
export interface ToolDispatchResult {
  result_text: string;
  is_error: boolean;
  /** USDC cost decrement from this call. */
  cost: string;
  events: FrameEvent[];
  tool_call?: ToolCall;
  /** Sub-agent run summary when the tool spawned a bounded sub-loop. */
  sub_run?: SubRun;
}

/** Per-entity sub-agent run, emitted by `refresh_entity`. */
export interface SubRun {
  entity_id: string;
  action: "facts_set" | "deprecated" | "no_change" | "no_op";
  stop_reason: string;
  facts_set: number;
  deprecations: number;
  iterations: number;
  iteration_log: import("@frames-ag/tick-types").IterationLogEntry[];
  tool_log: ToolCall[];
  llm_cost: string;
  narrative: string;
}
