// Project events.ndjson into SQLite + rows.ndjson.
// Pure & deterministic: same events → same projection.
// See PROTOCOL.md § Projection.

import { Database } from "./db.js";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type FactSetPayload,
  FrameError,
  type FrameEvent,
  type FrameSchema,
  type ProjectionStats,
  type Row,
  type Source,
  type ToolInvokedPayload,
} from "./types.js";
import { validateValue } from "./schema.js";

type ProjectionState = {
  entities: Map<string, { created_at: string; removed_at?: string; removed_reason?: string }>;
  // current[entity_id][field] = fact_id of the live fact for that pair
  current: Map<string, Map<string, string>>;
  // facts[fact_id] = full FactSet payload
  facts: Map<string, FactSetPayload & { ts: string; agent: string }>;
  // additional evidence attached after the fact's creation
  extraEvidence: Map<string, Source[]>;
  // deprecated fact IDs
  deprecated: Map<string, { reason: string; ts: string }>;
  // chronological order for facts on (entity, field) for revert-on-deprecation
  history: Map<string, string[]>; // key = `${entity_id}::${field}` → fact_ids in order
  // tool.invoked events keyed by the OUTER event id (the envelope id, not the
  // receipt id). Lets the projector dedupe replays and lets queries link a
  // fact's source.receipt_id to a row here via the stored receipt_id.
  toolInvocations: Map<
    string,
    {
      event_id: string;
      ts: string;
      agent: string;
      receipt: ToolInvokedPayload["receipt"];
      tool?: ToolInvokedPayload["tool"];
    }
  >;
};

function emptyState(): ProjectionState {
  return {
    entities: new Map(),
    current: new Map(),
    facts: new Map(),
    extraEvidence: new Map(),
    deprecated: new Map(),
    history: new Map(),
    toolInvocations: new Map(),
  };
}

// One event paired with the 1-based line number it originated from in
// events.ndjson. Used so referential errors can point at the offending line.
export type EventWithLine = { event: FrameEvent; line: number };

// Replay events and produce the in-memory projection state.
//
// Throws FrameError("OrphanEvent") on referential violations: fact.set against
// a non-existent entity, or fact.deprecated / evidence.attached against a
// non-existent fact. The SQL schema also enforces these via FOREIGN KEY, but
// folding catches them earlier with a useful message (line + event id + ts).
export function fold(events: FrameEvent[] | EventWithLine[]): ProjectionState {
  const tracked: EventWithLine[] = isTracked(events)
    ? events
    : events.map((event, i) => ({ event, line: i + 1 }));

  const s = emptyState();
  for (const { event: e, line } of tracked) {
    switch (e.type) {
      case "entity.created": {
        const p = e.payload as { entity_id: string };
        if (!s.entities.has(p.entity_id)) {
          s.entities.set(p.entity_id, { created_at: e.ts });
        }
        break;
      }
      case "fact.set": {
        const p = e.payload as FactSetPayload;
        if (!s.entities.has(p.entity_id)) {
          throw orphan(e, line, "fact.set", "entity_id", p.entity_id, {
            fact_id: p.fact_id,
          });
        }
        s.facts.set(p.fact_id, { ...p, ts: e.ts, agent: e.agent });

        const histKey = `${p.entity_id}::${p.field}`;
        const hist = s.history.get(histKey) ?? [];
        hist.push(p.fact_id);
        s.history.set(histKey, hist);

        // current = the latest non-deprecated fact for (entity, field)
        const currentForEntity = s.current.get(p.entity_id) ?? new Map();
        currentForEntity.set(p.field, p.fact_id);
        s.current.set(p.entity_id, currentForEntity);
        break;
      }
      case "facts.set_many": {
        // v0.2.0+ — atomic bulk-write of multiple facts to one entity.
        // Semantically equivalent to N fact.set events with the same outer ts,
        // applied in array order. Last-write-wins by (envelope.ts, array-order).
        const p = e.payload as {
          entity_id: string;
          facts: Array<{
            fact_id: string;
            field: string;
            value: unknown;
            source: Source;
            confidence?: number;
            observed_at?: string;
          }>;
        };
        if (!s.entities.has(p.entity_id)) {
          throw orphan(e, line, "facts.set_many", "entity_id", p.entity_id, {
            entity_id: p.entity_id,
          });
        }
        if (!Array.isArray(p.facts)) {
          throw orphan(e, line, "facts.set_many", "facts", "not-an-array");
        }
        const currentForEntity = s.current.get(p.entity_id) ?? new Map();
        for (const f of p.facts) {
          // Each fact in the bundle becomes a first-class fact in the index
          // (same shape as fact.set produces). Share the outer envelope's
          // ts and agent — the bundle IS one observation.
          s.facts.set(f.fact_id, {
            fact_id: f.fact_id,
            entity_id: p.entity_id,
            field: f.field,
            value: f.value,
            source: f.source,
            confidence: f.confidence,
            observed_at: f.observed_at,
            ts: e.ts,
            agent: e.agent,
          });
          const histKey = `${p.entity_id}::${f.field}`;
          const hist = s.history.get(histKey) ?? [];
          hist.push(f.fact_id);
          s.history.set(histKey, hist);
          currentForEntity.set(f.field, f.fact_id);
        }
        s.current.set(p.entity_id, currentForEntity);
        break;
      }
      case "fact.deprecated": {
        const p = e.payload as { fact_id: string; reason: string };
        if (!s.facts.has(p.fact_id)) {
          throw orphan(e, line, "fact.deprecated", "fact_id", p.fact_id);
        }
        s.deprecated.set(p.fact_id, { reason: p.reason, ts: e.ts });

        // If this was the current fact for its (entity, field), revert to the
        // most recent prior non-deprecated fact, if any.
        const fact = s.facts.get(p.fact_id)!;
        const histKey = `${fact.entity_id}::${fact.field}`;
        const hist = s.history.get(histKey) ?? [];
        const prior = [...hist].reverse().find(
          (fid) => fid !== p.fact_id && !s.deprecated.has(fid),
        );
        const currentForEntity = s.current.get(fact.entity_id);
        if (currentForEntity) {
          if (prior) {
            currentForEntity.set(fact.field, prior);
          } else {
            currentForEntity.delete(fact.field);
          }
        }
        break;
      }
      case "evidence.attached": {
        const p = e.payload as { fact_id: string; source: Source };
        if (!s.facts.has(p.fact_id)) {
          throw orphan(e, line, "evidence.attached", "fact_id", p.fact_id);
        }
        const arr = s.extraEvidence.get(p.fact_id) ?? [];
        arr.push(p.source);
        s.extraEvidence.set(p.fact_id, arr);
        break;
      }
      case "entity.removed": {
        const p = e.payload as { entity_id: string; reason: string };
        const ent = s.entities.get(p.entity_id);
        if (ent) {
          ent.removed_at = e.ts;
          ent.removed_reason = p.reason;
        }
        // Also clear current state — removed entity doesn't appear in rows.
        s.current.delete(p.entity_id);
        break;
      }
      case "tool.invoked": {
        // Pay-emitted receipt of a paid tool call. Frame doesn't validate the
        // signature here — the receipt is authoritative as written; offline
        // verification is a separate caller concern. We just index by the
        // outer event id (which dedupes replays from `frame verify`).
        const p = e.payload as ToolInvokedPayload;
        if (
          p &&
          typeof p === "object" &&
          p.receipt &&
          typeof p.receipt === "object" &&
          typeof p.receipt.id === "string"
        ) {
          if (!s.toolInvocations.has(e.id)) {
            s.toolInvocations.set(e.id, {
              event_id: e.id,
              ts: e.ts,
              agent: e.agent,
              receipt: p.receipt,
              ...(p.tool ? { tool: p.tool } : {}),
            });
          }
        }
        break;
      }
      // Unknown event types are skipped (forward-compat).
      default:
        break;
    }
  }
  return s;
}

function isTracked(
  events: FrameEvent[] | EventWithLine[],
): events is EventWithLine[] {
  return events.length === 0 || (events[0] as EventWithLine).event !== undefined;
}

function orphan(
  e: FrameEvent,
  line: number,
  evType: string,
  refField: string,
  refValue: string,
  extra: Record<string, unknown> = {},
): FrameError {
  return new FrameError(
    "OrphanEvent",
    `events.ndjson:${line} ${evType} references unknown ${refField}=${refValue} ` +
      `(event id=${e.id}, ts=${e.ts})`,
    { line, event_id: e.id, ts: e.ts, type: evType, [refField]: refValue, ...extra },
  );
}

// Materialize current rows from a projection state.
export function rowsFromState(s: ProjectionState, schema: FrameSchema): Row[] {
  const rows: Row[] = [];
  for (const [entity_id, ent] of s.entities) {
    if (ent.removed_at) continue;
    const fields: Record<string, unknown> = {};
    const currentForEntity = s.current.get(entity_id);
    if (currentForEntity) {
      for (const [field, fact_id] of currentForEntity) {
        const fact = s.facts.get(fact_id);
        if (fact) fields[field] = fact.value;
      }
    }
    const invalid: Row["invalid"] = [];
    for (const [field, def] of Object.entries(schema.fields)) {
      try {
        validateValue(field, def, fields[field]);
      } catch (e: any) {
        invalid.push({ reason: e?.message ?? String(e) });
      }
    }
    rows.push({
      entity_id,
      fields,
      ...(invalid.length > 0 ? { invalid } : {}),
    });
  }
  rows.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  return rows;
}

// Write the projection to .frame/dataset.db and .frame/rows.ndjson.
// Returns stats. The DB is destroyed and rebuilt — projection is idempotent.
//
// Atomicity: both files are built into sibling `.tmp` paths and atomically
// renamed over the live files at the end. If anything throws mid-build (FK
// violation, schema mismatch, disk error), the previous projection is left
// untouched — callers see the old `dataset.db` intact rather than a half-built
// one. Stale `.tmp` files from a prior crashed run are removed on entry.
export function writeProjection(
  frameDir: string,
  events: FrameEvent[] | EventWithLine[],
  schema: FrameSchema,
): ProjectionStats {
  const start = Date.now();
  const dotFrame = join(frameDir, ".frame");
  mkdirSync(dotFrame, { recursive: true });

  const state = fold(events);
  const rows = rowsFromState(state, schema);

  const rowsPath = join(dotFrame, "rows.ndjson");
  const rowsTmp = rowsPath + ".tmp";
  const dbPath = join(dotFrame, "dataset.db");
  const dbTmp = dbPath + ".tmp";

  // Clean up any stale tmp files from a previously interrupted projection.
  // Includes SQLite's rollback-journal sidecar, which would otherwise be
  // mistaken for an in-progress transaction on next open.
  for (const p of [rowsTmp, dbTmp, dbTmp + "-journal"]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // ── rows.ndjson ────────────────────────────────────────────────────────────
  writeFileSync(
    rowsTmp,
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );

  // ── dataset.db ─────────────────────────────────────────────────────────────
  // We rebuild from scratch on every project — no WAL, no incremental updates.
  // Default rollback-journal mode keeps the main .db file's mtime current,
  // which the doctor's freshness check relies on.
  const db = new Database(dbTmp);
  try {
    db.exec("DROP VIEW  IF EXISTS all_sources;");
    db.exec("DROP TABLE IF EXISTS rows;");
    db.exec("DROP TABLE IF EXISTS facts;");
    db.exec("DROP TABLE IF EXISTS evidence;");
    db.exec("DROP TABLE IF EXISTS entities;");
    db.exec("DROP TABLE IF EXISTS tool_invocations;");

    db.exec(`
      CREATE TABLE entities (
        entity_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        removed_at TEXT,
        removed_reason TEXT
      );
      CREATE TABLE facts (
        fact_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_retrieved_at TEXT NOT NULL,
        source_title TEXT,
        source_archive_url TEXT,
        source_excerpt TEXT,
        source_receipt_id TEXT,
        confidence REAL,
        observed_at TEXT,
        ts TEXT NOT NULL,
        agent TEXT NOT NULL,
        deprecated INTEGER NOT NULL DEFAULT 0,
        deprecation_reason TEXT,
        FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
      );
      CREATE INDEX idx_facts_entity_field ON facts(entity_id, field);
      CREATE INDEX idx_facts_receipt    ON facts(source_receipt_id);
      CREATE TABLE evidence (
        fact_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_retrieved_at TEXT NOT NULL,
        source_title TEXT,
        source_archive_url TEXT,
        source_excerpt TEXT,
        source_receipt_id TEXT,
        FOREIGN KEY (fact_id) REFERENCES facts(fact_id)
      );
      CREATE TABLE rows (
        entity_id TEXT PRIMARY KEY,
        fields_json TEXT NOT NULL,
        invalid_json TEXT
      );
      -- One row per tool.invoked event. event_id is the OUTER envelope id
      -- (deduped); receipt_id is pay's receipt.id (what facts link to via
      -- source.receipt_id).
      CREATE TABLE tool_invocations (
        event_id              TEXT PRIMARY KEY,
        receipt_id            TEXT NOT NULL,
        ts                    TEXT NOT NULL,
        agent                 TEXT NOT NULL,
        tool_id               TEXT NOT NULL,
        tool_local_name       TEXT,
        descriptor_id         TEXT NOT NULL,
        params_hash           TEXT NOT NULL,
        protocol              TEXT NOT NULL,
        wallet_id             TEXT NOT NULL,
        wallet_address        TEXT NOT NULL,
        amount                TEXT NOT NULL,
        currency              TEXT NOT NULL,
        network               TEXT NOT NULL,
        facilitator_url       TEXT,
        tx_hash               TEXT,
        request_hash          TEXT,
        response_hash         TEXT,
        signature             TEXT NOT NULL,
        params_json           TEXT,
        response_excerpt      TEXT,
        response_size_bytes   INTEGER,
        response_truncated    INTEGER
      );
      CREATE INDEX idx_tool_invocations_receipt ON tool_invocations(receipt_id);
      CREATE INDEX idx_tool_invocations_ts      ON tool_invocations(ts);
    `);

    const insertEntity = db.prepare(`
      INSERT INTO entities (entity_id, created_at, removed_at, removed_reason)
      VALUES (?, ?, ?, ?)
    `);
    for (const [entity_id, ent] of state.entities) {
      insertEntity.run(
        entity_id,
        ent.created_at,
        ent.removed_at ?? null,
        ent.removed_reason ?? null,
      );
    }

    const insertFact = db.prepare(`
      INSERT INTO facts (
        fact_id, entity_id, field, value_json,
        source_url, source_retrieved_at, source_title, source_archive_url, source_excerpt, source_receipt_id,
        confidence, observed_at, ts, agent, deprecated, deprecation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [fact_id, fact] of state.facts) {
      const dep = state.deprecated.get(fact_id);
      insertFact.run(
        fact_id,
        fact.entity_id,
        fact.field,
        JSON.stringify(fact.value),
        fact.source.url,
        fact.source.retrieved_at,
        fact.source.title ?? null,
        fact.source.archive_url ?? null,
        fact.source.excerpt ?? null,
        fact.source.receipt_id ?? null,
        fact.confidence ?? null,
        fact.observed_at ?? null,
        fact.ts,
        fact.agent,
        dep ? 1 : 0,
        dep?.reason ?? null,
      );
    }

    const insertEvidence = db.prepare(`
      INSERT INTO evidence (
        fact_id, source_url, source_retrieved_at, source_title, source_archive_url, source_excerpt, source_receipt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [fact_id, sources] of state.extraEvidence) {
      for (const src of sources) {
        insertEvidence.run(
          fact_id,
          src.url,
          src.retrieved_at,
          src.title ?? null,
          src.archive_url ?? null,
          src.excerpt ?? null,
          src.receipt_id ?? null,
        );
      }
    }

    const insertToolInvocation = db.prepare(`
      INSERT INTO tool_invocations (
        event_id, receipt_id, ts, agent,
        tool_id, tool_local_name, descriptor_id, params_hash, protocol,
        wallet_id, wallet_address, amount, currency, network,
        facilitator_url, tx_hash, request_hash, response_hash, signature,
        params_json, response_excerpt, response_size_bytes, response_truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [, ti] of state.toolInvocations) {
      const r = ti.receipt;
      insertToolInvocation.run(
        ti.event_id,
        r.id,
        ti.ts,
        ti.agent,
        r.tool_id,
        r.tool_local_name ?? null,
        r.descriptor_id,
        r.params_hash,
        r.protocol,
        r.wallet_id,
        r.wallet_address,
        r.amount,
        r.currency,
        r.network,
        r.facilitator_url ?? null,
        r.tx_hash ?? null,
        r.request_hash ?? null,
        r.response_hash ?? null,
        r.signature,
        ti.tool?.params !== undefined ? JSON.stringify(ti.tool.params) : null,
        ti.tool?.response_excerpt ?? null,
        ti.tool?.response_size_bytes ?? null,
        ti.tool?.response_truncated === undefined
          ? null
          : ti.tool.response_truncated
            ? 1
            : 0,
      );
    }

    const insertRow = db.prepare(`
      INSERT INTO rows (entity_id, fields_json, invalid_json) VALUES (?, ?, ?)
    `);
    for (const r of rows) {
      insertRow.run(
        r.entity_id,
        JSON.stringify(r.fields),
        r.invalid ? JSON.stringify(r.invalid) : null,
      );
    }

    // ── Convenience view: every source (primary + corroborating) for every
    //    live fact in one queryable place. Use when you want the complete
    //    evidence picture without UNION-ing two tables yourself.
    db.exec(`
      CREATE VIEW all_sources AS
        SELECT fact_id, entity_id, field,
               source_url, source_retrieved_at, source_title,
               source_archive_url, source_excerpt, source_receipt_id,
               1 AS is_primary
          FROM facts WHERE deprecated = 0
        UNION ALL
        SELECT e.fact_id, f.entity_id, f.field,
               e.source_url, e.source_retrieved_at, e.source_title,
               e.source_archive_url, e.source_excerpt, e.source_receipt_id,
               0 AS is_primary
          FROM evidence e JOIN facts f ON f.fact_id = e.fact_id
          WHERE f.deprecated = 0;
    `);
    db.close();
  } catch (e) {
    // Build failed — discard the half-built tmp DB so the live one stays
    // authoritative and the next run starts clean.
    try { db.close(); } catch {}
    for (const p of [rowsTmp, dbTmp, dbTmp + "-journal"]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
    throw e;
  }

  // Atomic swap. POSIX rename(2) replaces the target in a single step on the
  // same filesystem, so readers never observe a partially-written file.
  renameSync(rowsTmp, rowsPath);
  renameSync(dbTmp, dbPath);

  return {
    entity_count: rows.length,
    fact_count: state.facts.size,
    deprecated_count: state.deprecated.size,
    invalid_row_count: rows.filter((r) => r.invalid && r.invalid.length > 0).length,
    duration_ms: Date.now() - start,
  };
}

// Re-export path helpers for caller convenience.
export { dirname, join };
