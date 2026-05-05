// Core types for the frame protocol v0.1.0.
// See PROTOCOL.md for the canonical spec.

export const PROTOCOL_VERSION = "0.0.1";

// ─── Sources ─────────────────────────────────────────────────────────────────

export type Source = {
  url: string;
  retrieved_at: string;
  title?: string;
  archive_url?: string;
  excerpt?: string;
  /**
   * Optional ID of a `tool.invoked` receipt that produced the source URL.
   * Lets a single fact link forward to the paid call that backed it,
   * tying frame's evidence trail to pay's receipts. See pay/SPEC.md
   * §"Frame integration". Forward-compatible: older readers ignore.
   */
  receipt_id?: string;
};

// ─── Pay-receipt shape (mirrors pay/SPEC.md §Receipt) ────────────────────────
//
// Frame doesn't validate receipts — it just stores and surfaces them. Pay is
// the authoritative emitter; the signature anchors verification offline.

export type ToolInvokedReceipt = {
  pay_protocol: string;
  id: string;
  ts: string;
  tool_local_name?: string;
  tool_id: string;
  descriptor_id: string;
  params_hash: string;
  protocol: string;
  wallet_id: string;
  wallet_address: string;
  amount: string;
  currency: string;
  network: string;
  facilitator_url?: string;
  tx_hash?: string;
  request_hash?: string;
  response_hash?: string;
  agent: string;
  signature: string;
};

export type ToolInvokedToolPayload = {
  params: unknown;
  response_excerpt?: string;
  response_size_bytes?: number;
  response_truncated?: boolean;
};

export type ToolInvokedPayload = {
  receipt: ToolInvokedReceipt;
  tool?: ToolInvokedToolPayload;
};

// ─── Schema ──────────────────────────────────────────────────────────────────

export type FieldType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "date"
  | "url"
  | "enum";

export type FieldDef = {
  type: FieldType;
  required?: boolean;
  values?: string[]; // for enum
  description?: string;
};

export type TestRule =
  | { name: string; field: string; rule: "enum"; allowed: string[] }
  | { name: string; field: string; rule: "regex"; pattern: string }
  | { name: string; field: string; rule: "range"; min?: number; max?: number };

export type FrameSchema = {
  frame_protocol: string;
  name: string;
  description?: string;
  entity_type?: string;
  fields: Record<string, FieldDef>;
  tests?: TestRule[];
  allow_unknown_fields?: boolean;
};

// ─── Events ──────────────────────────────────────────────────────────────────

export type EventType =
  | "entity.created"
  | "fact.set"
  | "fact.deprecated"
  | "evidence.attached"
  | "entity.removed"
  // Emitted by pay (or any future cost-bearing tool runner) when a paid
  // tool call fires from inside a frame loop. Frame projector indexes
  // these into a tool_invocations table for audit and cost rollups.
  | "tool.invoked";

export type AgentId = string; // "<kind>:<identifier>", e.g. "claude:opus-4.7"

export type EventEnvelope<P = unknown> = {
  id: string;
  ts: string;
  type: EventType | string; // string allows forward-compat unknown types
  agent: AgentId;
  payload: P;
};

export type EntityCreatedPayload = {
  entity_id: string;
};

export type FactSetPayload = {
  fact_id: string;
  entity_id: string;
  field: string;
  value: unknown;
  source: Source;
  confidence?: number;
  observed_at?: string;
};

export type FactDeprecatedPayload = {
  fact_id: string;
  reason: string;
};

export type EvidenceAttachedPayload = {
  fact_id: string;
  source: Source;
};

export type EntityRemovedPayload = {
  entity_id: string;
  reason: string;
};

export type FrameEvent =
  | EventEnvelope<EntityCreatedPayload> & { type: "entity.created" }
  | EventEnvelope<FactSetPayload> & { type: "fact.set" }
  | EventEnvelope<FactDeprecatedPayload> & { type: "fact.deprecated" }
  | EventEnvelope<EvidenceAttachedPayload> & { type: "evidence.attached" }
  | EventEnvelope<EntityRemovedPayload> & { type: "entity.removed" }
  | EventEnvelope<ToolInvokedPayload> & { type: "tool.invoked" };

// ─── Projection ──────────────────────────────────────────────────────────────

export type Row = {
  entity_id: string;
  fields: Record<string, unknown>;
  invalid?: { reason: string }[];
  // Present only when query is called with include_sources: true.
  // Maps each field name to its primary (live) source.
  sources?: Record<string, Source>;
};

export type ProjectionStats = {
  entity_count: number;
  fact_count: number;
  deprecated_count: number;
  invalid_row_count: number;
  duration_ms: number;
};

// ─── Tool-invocation query (paid-call audit trail) ───────────────────────────

export type ToolInvocationsQuery = {
  /** ISO 8601 lower-bound on `ts`. */
  since?: string;
  /** Match by tool_id OR tool_local_name. */
  tool_id?: string;
  /** Cap the result count. */
  limit?: number;
};

export type ToolInvocationRow = {
  // Outer envelope id of the tool.invoked event (deduped).
  event_id: string;
  // Pay's receipt.id — the value any fact's source.receipt_id can refer to.
  receipt_id: string;
  ts: string;
  agent: string;
  tool_id: string;
  tool_local_name?: string;
  descriptor_id: string;
  params_hash: string;
  protocol: string;
  wallet_id: string;
  wallet_address: string;
  amount: string;
  currency: string;
  network: string;
  facilitator_url?: string;
  tx_hash?: string;
  request_hash?: string;
  response_hash?: string;
  signature: string;
  // Set when the source event included payload.tool (input/output excerpt).
  params?: unknown;
  response_excerpt?: string;
  response_size_bytes?: number;
  response_truncated?: boolean;
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export class FrameError extends Error {
  override readonly name = "FrameError";
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
