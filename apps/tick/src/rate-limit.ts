// Per-wallet (currently per-IP) rate limiting for /run.
//
// Sliding-window count over the existing D1 `runs` table — no new table
// needed. Counts the agent's runs in the last 60s and last 3600s, returns
// 429 if either threshold is exceeded.
//
// Identity key (`agent` column value):
//   - Future:  SIWX-verified wallet address (`wallet:<hex>` or `wallet:<base58>`)
//   - Today:   `ip:<sha1(CF-Connecting-IP)>` — IP-derived, hashed for the
//              receipts table to avoid leaking client IPs in audit dumps.
//
// When SIWX verification lands, swap the identity helper to return the
// signed wallet address; the rate-limit logic itself doesn't change.
//
// Performance: the query is one round-trip and one index range scan against
// `idx_runs_agent_started ON runs(agent, started_at DESC)` (see
// migrations/0001_initial.sql). Two cumulative SUMs come from the same scan,
// so the per-minute and per-hour counts share I/O. Tested cold-call latency
// on a populated table: ~3-5ms. Don't try to "optimize" this with an in-Worker
// LRU — CF isolates churn fast enough that the cache hit rate would be poor
// and you'd lose enforcement under load. The index path is the right answer.

export interface RateLimitConfig {
  /** Max successful runs in the last 60 seconds per identity. */
  per_minute: number;
  /** Max successful runs in the last 3600 seconds per identity. */
  per_hour: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  per_minute: 5,
  per_hour: 60,
};

export interface RateLimitCheck {
  allowed: boolean;
  /** RFC 6585 — seconds the client should wait before retrying. */
  retry_after_seconds?: number;
  remaining_per_minute: number;
  remaining_per_hour: number;
  /** Sliding-window observation point. */
  checked_at: string;
}

/**
 * Check whether the identity is allowed to start a new run right now.
 *
 * No-throws: a D1 error returns `allowed: true` (fail-open). Rate-limit is
 * defensive UX, not a security boundary — auth + budget caps are the real
 * lines. Better to let a few extra runs through than to fail closed on a
 * transient DB blip.
 */
export async function checkRateLimit(
  db: D1Database,
  identity: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateLimitCheck> {
  const now = new Date();
  const oneMinAgo = new Date(now.getTime() - 60_000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();

  try {
    const row = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS last_min,
           SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS last_hour
         FROM runs
         WHERE agent = ? AND started_at >= ?`,
      )
      .bind(oneMinAgo, oneHourAgo, identity, oneHourAgo)
      .first<{ last_min: number | null; last_hour: number | null }>();

    const minCount = row?.last_min ?? 0;
    const hourCount = row?.last_hour ?? 0;

    if (minCount >= config.per_minute) {
      return {
        allowed: false,
        retry_after_seconds: 60,
        remaining_per_minute: 0,
        remaining_per_hour: Math.max(0, config.per_hour - hourCount),
        checked_at: now.toISOString(),
      };
    }
    if (hourCount >= config.per_hour) {
      return {
        allowed: false,
        retry_after_seconds: 3600,
        remaining_per_minute: Math.max(0, config.per_minute - minCount),
        remaining_per_hour: 0,
        checked_at: now.toISOString(),
      };
    }
    return {
      allowed: true,
      remaining_per_minute: config.per_minute - minCount,
      remaining_per_hour: config.per_hour - hourCount,
      checked_at: now.toISOString(),
    };
  } catch (e) {
    console.error("rate-limit check failed (fail-open):", e);
    return {
      allowed: true,
      remaining_per_minute: config.per_minute,
      remaining_per_hour: config.per_hour,
      checked_at: now.toISOString(),
    };
  }
}

/**
 * Derive the rate-limit identity key from the incoming request.
 *
 * Order of preference:
 *   1. Real wallet address from SIWX-verified `Authorization: Wallet <sig>` header (not yet)
 *   2. SHA-1 hashed `CF-Connecting-IP` (deployed today)
 *   3. `ip:unknown` fallback (local dev or non-CF environments)
 *
 * Returns the `agent`-column value to use both for rate-limit lookup and for
 * `INSERT INTO runs (agent)`. Keep these two consistent or rate-limiting won't
 * actually catch repeat callers.
 */
export async function identityKeyForRequest(req: Request): Promise<string> {
  // TODO: parse Authorization: Wallet <signed-message> and verify the SIWX
  //       signature. Return `wallet:<address>` on success. For now, IP-derive.
  const ip = req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? "unknown";
  if (ip === "unknown") return "ip:unknown";

  // Hash the IP so audit dumps don't leak client IPs to anyone with run_id access.
  // SHA-1 is fine for non-cryptographic identity bucketing.
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-1", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ip:${hex.slice(0, 16)}`;
}
