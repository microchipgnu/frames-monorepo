-- Idempotency support for POST /run.
--
-- Customers send `Idempotency-Key: <opaque>` to make /run safe to retry on
-- timeouts. Same key within 24h returns the original run's result (or a 409
-- if the original is still running). UNIQUE constraint catches double-writes
-- under concurrent retries.

ALTER TABLE runs ADD COLUMN idempotency_key TEXT;

-- Partial index — only enforced when the column is non-null. NULL keys are
-- allowed and never collide (legacy/non-idempotent callers stay working).
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency_key
  ON runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
