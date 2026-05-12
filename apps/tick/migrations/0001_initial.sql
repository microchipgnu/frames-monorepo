-- tick D1 schema — initial.
--
-- Three tables, all joined by run_id. Each `/run` invocation produces:
--   - 1 row in `runs` (the receipt header)
--   - N rows in `tool_calls` (per paid or free tool invocation)
--   - M rows in `events` (the frame events written during the run)
--
-- run_id is opaque ("run_<uuid>") and matches the run_id field on every
-- frame event the runtime emits (frame protocol v0.2.0). Anyone with the
-- run_id can join events.ndjson lines to tool_calls and reconstruct the
-- full provenance chain for any fact written by this runtime.
--
-- Wallet identity ("agent" column) is the canonical SIWX-derived address
-- formatted as "frames-runtime:<wallet-address>". Same format used in the
-- frame event envelope's `agent` field, so a join on agent across customer's
-- events.ndjson and our `runs.agent` returns the same rows.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- runs — one row per /run invocation. The receipt header.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  op                TEXT NOT NULL CHECK (op IN ('curate','refresh','verify','discover')),
  frame             TEXT NOT NULL,             -- https://github.com/<user>/<repo>[/<path>]
  agent             TEXT NOT NULL,             -- 'frames-runtime:<wallet-address>'
  budget            TEXT NOT NULL,             -- USDC string, the upto ceiling
  settled           TEXT NOT NULL DEFAULT '0', -- USDC actually consumed (<= budget)
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','completed','failed','aborted')),
  started_at        TEXT NOT NULL,             -- ISO 8601
  ended_at          TEXT,                       -- nullable until terminal
  region            TEXT,                       -- CF colo that handled the run
  summary           TEXT,                       -- agent's final natural-language summary
  error             TEXT,                       -- populated only on failed runs

  -- Payment plane metadata. payment_protocol mirrors pay's
  -- `descriptor.payment.protocol` discriminator.
  payment_protocol  TEXT NOT NULL CHECK (payment_protocol IN ('x402','x402v2','mpp')),
  payment_network   TEXT NOT NULL,             -- 'base', 'solana', 'tempo', etc.
  payment_tx_hash   TEXT,                       -- chain tx hash (post-settle)
  payment_intent_id TEXT,                       -- MPP intent id (nullable for x402 runs)

  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_agent_started   ON runs(agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_frame           ON runs(frame);
CREATE INDEX IF NOT EXISTS idx_runs_status          ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_payment_tx_hash ON runs(payment_tx_hash) WHERE payment_tx_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tool_calls — one row per paid (or free) tool invocation during a run.
--
-- Both paid (cost > 0) and free (cost = 0, e.g. GitHub API, Polymarket public)
-- calls go here. Receipts cite source_url; frame fact `source.url` values
-- written during the same run can be joined back to the tool call that
-- produced them via (run_id, source_url).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tool_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  seq                 INTEGER NOT NULL,        -- 0-based order within the run
  descriptor_id       TEXT NOT NULL,           -- 'sha256-...' from the catalog
  tool_id             TEXT NOT NULL,           -- 'search.exa', 'github.repos.get', etc.
  cost                TEXT NOT NULL DEFAULT '0', -- USDC string ('0' for free)
  source_url          TEXT,                    -- result's canonical source URL (if any)
  retrieved_at        TEXT NOT NULL,           -- ISO 8601 when the call returned
  input_hash          TEXT NOT NULL,           -- sha256(canonical(input_json))
  response_size_bytes INTEGER,
  duration_ms         INTEGER,
  error               TEXT,                    -- error message if the call failed

  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run_seq    ON tool_calls(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_descriptor ON tool_calls(descriptor_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_source_url ON tool_calls(source_url) WHERE source_url IS NOT NULL;

-- ---------------------------------------------------------------------------
-- events — frame events the runtime wrote during the run.
--
-- These are the same `events.ndjson` lines we return to the caller (Mode 1)
-- or commit back to the customer's repo (Mode 2). Storing them locally gives
-- us a queryable receipt without re-fetching the customer's repo.
--
-- The `payload` column is canonical JSON of the event payload (NOT the whole
-- envelope — outer fields are extracted to columns). Reconstructing the
-- envelope: { id: event_id, ts, type, agent, run_id, payload: JSON(payload) }.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  event_id          TEXT PRIMARY KEY,          -- UUID v4 from the envelope
  run_id            TEXT NOT NULL,
  seq               INTEGER NOT NULL,          -- 0-based order within the run
  ts                TEXT NOT NULL,             -- ISO 8601, envelope's ts
  type              TEXT NOT NULL,             -- 'entity.created','fact.set','facts.set_many', etc.
  agent             TEXT NOT NULL,             -- 'frames-runtime:<wallet>'
  entity_id         TEXT,                      -- denormalized from payload for fast filter
  payload           TEXT NOT NULL,             -- canonical JSON of the event payload
  emitted_to_frame  INTEGER NOT NULL DEFAULT 0, -- 1 if Mode 2 wrote it back, else 0

  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_run_seq   ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_entity_id ON events(entity_id) WHERE entity_id IS NOT NULL;
