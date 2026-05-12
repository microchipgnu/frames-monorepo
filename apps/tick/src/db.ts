// Typed accessors for the D1 receipts store.
// Schema in migrations/0001_initial.sql; row types here mirror columns 1:1.

import type { FrameEvent, Op, ToolCall } from "@frames-ag/tick-types";

// ---------------------------------------------------------------------------
// Row shapes (mirror migrations/0001_initial.sql exactly)
// ---------------------------------------------------------------------------

export interface RunRow {
  run_id: string;
  op: Op;
  frame: string;
  agent: string;
  budget: string;
  settled: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  started_at: string;
  ended_at: string | null;
  region: string | null;
  summary: string | null;
  error: string | null;
  payment_protocol: "x402" | "x402v2" | "mpp";
  payment_network: string;
  payment_tx_hash: string | null;
  payment_intent_id: string | null;
  created_at: string;
  /** v0.0.0+ (migration 0002) — populated when a client sends `Idempotency-Key`. */
  idempotency_key?: string | null;
}

export interface ToolCallRow {
  id: number;
  run_id: string;
  seq: number;
  descriptor_id: string;
  tool_id: string;
  cost: string;
  source_url: string | null;
  retrieved_at: string;
  input_hash: string;
  response_size_bytes: number | null;
  duration_ms: number | null;
  error: string | null;
}

export interface EventRow {
  event_id: string;
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  agent: string;
  entity_id: string | null;
  payload: string; // canonical JSON, parse to access
  emitted_to_frame: 0 | 1;
}

// ---------------------------------------------------------------------------
// Insert / update helpers (week 2 wires these into the agent loop)
// ---------------------------------------------------------------------------

export async function insertRun(
  db: D1Database,
  run: Omit<RunRow, "ended_at" | "region" | "summary" | "error" | "payment_tx_hash" | "payment_intent_id" | "created_at"> & {
    idempotency_key?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (run_id, op, frame, agent, budget, settled, status, started_at, payment_protocol, payment_network, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.run_id,
      run.op,
      run.frame,
      run.agent,
      run.budget,
      run.settled,
      run.status,
      run.started_at,
      run.payment_protocol,
      run.payment_network,
      run.idempotency_key ?? null,
    )
    .run();
}

/** Lookup the run that previously claimed this idempotency key, if any. */
export async function findRunByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<RunRow | null> {
  return await db
    .prepare(`SELECT * FROM runs WHERE idempotency_key = ? LIMIT 1`)
    .bind(key)
    .first<RunRow>();
}

/** GDPR: purge a wallet's runs (cascade-deletes tool_calls + events via FK). */
export async function purgeRunsByAgent(db: D1Database, agent: string): Promise<{ deleted: number }> {
  const res = await db
    .prepare(`DELETE FROM runs WHERE agent = ?`)
    .bind(agent)
    .run();
  return { deleted: res.meta?.changes ?? 0 };
}

export async function finalizeRun(
  db: D1Database,
  run_id: string,
  patch: {
    status: RunRow["status"];
    settled: string;
    ended_at: string;
    summary?: string;
    error?: string;
    payment_tx_hash?: string;
    payment_intent_id?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs
       SET status = ?, settled = ?, ended_at = ?, summary = ?, error = ?, payment_tx_hash = ?, payment_intent_id = ?
       WHERE run_id = ?`,
    )
    .bind(
      patch.status,
      patch.settled,
      patch.ended_at,
      patch.summary ?? null,
      patch.error ?? null,
      patch.payment_tx_hash ?? null,
      patch.payment_intent_id ?? null,
      run_id,
    )
    .run();
}

export async function insertToolCall(
  db: D1Database,
  run_id: string,
  seq: number,
  call: ToolCall & { response_size_bytes?: number; duration_ms?: number; error?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tool_calls (run_id, seq, descriptor_id, tool_id, cost, source_url, retrieved_at, input_hash, response_size_bytes, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run_id,
      seq,
      call.descriptor_id,
      call.tool_id,
      call.cost,
      call.source_url ?? null,
      call.retrieved_at,
      call.input_hash,
      call.response_size_bytes ?? null,
      call.duration_ms ?? null,
      call.error ?? null,
    )
    .run();
}

export async function insertEvent(
  db: D1Database,
  run_id: string,
  seq: number,
  event: FrameEvent,
  entityId: string | null,
  emittedToFrame: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (event_id, run_id, seq, ts, type, agent, entity_id, payload, emitted_to_frame)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      run_id,
      seq,
      event.ts,
      event.type,
      event.agent,
      entityId,
      JSON.stringify(event.payload),
      emittedToFrame ? 1 : 0,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Read helpers (week 5 wires these into the SIWX-gated read endpoints)
// ---------------------------------------------------------------------------

export async function getRun(db: D1Database, run_id: string): Promise<RunRow | null> {
  const result = await db.prepare(`SELECT * FROM runs WHERE run_id = ?`).bind(run_id).first<RunRow>();
  return result ?? null;
}

export async function getRunEvents(db: D1Database, run_id: string): Promise<EventRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC`)
    .bind(run_id)
    .all<EventRow>();
  return results;
}

export async function getRunToolCalls(db: D1Database, run_id: string): Promise<ToolCallRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM tool_calls WHERE run_id = ? ORDER BY seq ASC`)
    .bind(run_id)
    .all<ToolCallRow>();
  return results;
}

export async function listRunsByAgent(
  db: D1Database,
  agent: string,
  limit = 20,
): Promise<RunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM runs WHERE agent = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(agent, limit)
    .all<RunRow>();
  return results;
}
