// Rate-limit identity derivation + sliding-window math.

import { describe, expect, test, mock } from "bun:test";
import { checkRateLimit, identityKeyForRequest, DEFAULT_RATE_LIMITS } from "../src/rate-limit.ts";

// ---------------------------------------------------------------------------
// identityKeyForRequest
// ---------------------------------------------------------------------------

describe("identityKeyForRequest", () => {
  test("derives ip:<hash> from CF-Connecting-IP", async () => {
    const req = new Request("https://tick.frames.ag/run", {
      headers: { "CF-Connecting-IP": "203.0.113.42" },
    });
    const key = await identityKeyForRequest(req);
    expect(key).toMatch(/^ip:[0-9a-f]{16}$/);
  });

  test("two different IPs produce different keys", async () => {
    const a = await identityKeyForRequest(
      new Request("https://tick.frames.ag/run", { headers: { "CF-Connecting-IP": "1.1.1.1" } }),
    );
    const b = await identityKeyForRequest(
      new Request("https://tick.frames.ag/run", { headers: { "CF-Connecting-IP": "2.2.2.2" } }),
    );
    expect(a).not.toBe(b);
  });

  test("same IP produces same key (deterministic)", async () => {
    const a = await identityKeyForRequest(
      new Request("https://tick.frames.ag/run", { headers: { "CF-Connecting-IP": "8.8.8.8" } }),
    );
    const b = await identityKeyForRequest(
      new Request("https://tick.frames.ag/run", { headers: { "CF-Connecting-IP": "8.8.8.8" } }),
    );
    expect(a).toBe(b);
  });

  test("falls through to X-Forwarded-For", async () => {
    const req = new Request("https://tick.frames.ag/run", {
      headers: { "X-Forwarded-For": "198.51.100.7" },
    });
    const key = await identityKeyForRequest(req);
    expect(key).toMatch(/^ip:[0-9a-f]{16}$/);
  });

  test("returns ip:unknown when no IP headers present", async () => {
    const req = new Request("https://tick.frames.ag/run");
    const key = await identityKeyForRequest(req);
    expect(key).toBe("ip:unknown");
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit — windowed counts against a mock D1
// ---------------------------------------------------------------------------

function mockDb(row: { last_min: number; last_hour: number } | null, throws = false): any {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (throws) throw new Error("simulated D1 outage");
              return row;
            },
          };
        },
      };
    },
  };
}

describe("checkRateLimit", () => {
  test("allows when no prior runs", async () => {
    const db = mockDb({ last_min: 0, last_hour: 0 });
    const result = await checkRateLimit(db, "ip:deadbeef");
    expect(result.allowed).toBe(true);
    expect(result.remaining_per_minute).toBe(DEFAULT_RATE_LIMITS.per_minute);
    expect(result.remaining_per_hour).toBe(DEFAULT_RATE_LIMITS.per_hour);
  });

  test("blocks when per_minute exceeded", async () => {
    const db = mockDb({ last_min: 5, last_hour: 10 });
    const result = await checkRateLimit(db, "ip:deadbeef", { per_minute: 5, per_hour: 60 });
    expect(result.allowed).toBe(false);
    expect(result.retry_after_seconds).toBe(60);
    expect(result.remaining_per_minute).toBe(0);
    expect(result.remaining_per_hour).toBe(50);
  });

  test("blocks when per_hour exceeded but not per_minute", async () => {
    const db = mockDb({ last_min: 2, last_hour: 60 });
    const result = await checkRateLimit(db, "ip:deadbeef", { per_minute: 5, per_hour: 60 });
    expect(result.allowed).toBe(false);
    expect(result.retry_after_seconds).toBe(3600);
    expect(result.remaining_per_minute).toBe(3);
    expect(result.remaining_per_hour).toBe(0);
  });

  test("allows when both windows have headroom", async () => {
    const db = mockDb({ last_min: 3, last_hour: 40 });
    const result = await checkRateLimit(db, "ip:deadbeef", { per_minute: 5, per_hour: 60 });
    expect(result.allowed).toBe(true);
    expect(result.remaining_per_minute).toBe(2);
    expect(result.remaining_per_hour).toBe(20);
  });

  test("handles null row (no matching runs) as zero counts", async () => {
    const db = mockDb(null);
    const result = await checkRateLimit(db, "ip:deadbeef");
    expect(result.allowed).toBe(true);
    expect(result.remaining_per_minute).toBe(DEFAULT_RATE_LIMITS.per_minute);
  });

  test("fail-open on D1 errors", async () => {
    const db = mockDb(null, true);
    // Suppress the expected console.error
    const origError = console.error;
    console.error = mock(() => {});
    try {
      const result = await checkRateLimit(db, "ip:deadbeef");
      expect(result.allowed).toBe(true);
      expect(result.remaining_per_minute).toBe(DEFAULT_RATE_LIMITS.per_minute);
    } finally {
      console.error = origError;
    }
  });
});
