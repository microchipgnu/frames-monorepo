// Tests for the verify op's drift classifier. Mock out the FrameClient and
// the Refetcher; verify how each combination of "what came back from the
// refetch" maps onto a Drift kind.

import { describe, expect, test } from "bun:test";
import type { Refetcher } from "../src/ops/types.ts";
import { verify } from "../src/ops/verify.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockClient(entities: Array<{ entity_id: string; fields: Record<string, unknown>; evidence?: Record<string, Array<{ url: string; retrieved_at: string; excerpt?: string }>> }>) {
  return {
    async getSchema(_url: string) {
      return { frame_protocol: "0.2.0", name: "test", fields: { f: { type: "string" } } };
    },
    async getMeta(_url: string) {
      return { user: "u", repo: "r", sha: "abc1234", frame_path: "", schema_name: "test", entity_count: entities.length, fields: ["f"], max_ts: "2026-05-11T00:00:00Z" };
    },
    async *iterateEntities() {
      for (const e of entities) yield e;
    },
  } as any;
}

function mockRefetcher(impl: (url: string) => Awaited<ReturnType<Refetcher>>): Refetcher {
  return async ({ url }) => impl(url);
}

const baseArgs = {
  frame_url: "https://github.com/u/r",
  budget: "1.00",
  run_id: "run_test",
  agent: "frames-runtime:test",
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("verify drift classification", () => {
  test("source_dead when refetcher returns ok:false", async () => {
    const result = await verify({
      ...baseArgs,
      client: mockClient([{ entity_id: "e1", fields: { f: "v" }, evidence: { f: [{ url: "https://example.com", retrieved_at: "2026-05-11T00:00:00Z" }] } }]),
      refetcher: mockRefetcher(() => ({ ok: false, final_url: "https://example.com", error: "HTTP 404" })),
    });
    const drifts = result.report!.drifts as any[];
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind).toBe("source_dead");
    expect(drifts[0].error).toBe("HTTP 404");
  });

  test("excerpt_missing when body present but excerpt not in body", async () => {
    const result = await verify({
      ...baseArgs,
      client: mockClient([{ entity_id: "e1", fields: { f: "Berlin" }, evidence: { f: [{ url: "https://example.com", retrieved_at: "2026-05-11T00:00:00Z", excerpt: "founded in Berlin in 2024" }] } }]),
      refetcher: mockRefetcher(() => ({ ok: true, final_url: "https://example.com", body: "Some unrelated content here", body_bytes: 27 })),
    });
    const drifts = result.report!.drifts as any[];
    expect(drifts.some((d) => d.kind === "excerpt_missing")).toBe(true);
  });

  test("source_redirect when final_url differs from primary", async () => {
    const result = await verify({
      ...baseArgs,
      client: mockClient([{ entity_id: "e1", fields: { f: "v" }, evidence: { f: [{ url: "https://example.com/a", retrieved_at: "2026-05-11T00:00:00Z" }] } }]),
      refetcher: mockRefetcher(() => ({ ok: true, final_url: "https://example.com/b", body: "v appears here" })),
    });
    const drifts = result.report!.drifts as any[];
    expect(drifts.some((d) => d.kind === "source_redirect" && d.redirect_to === "https://example.com/b")).toBe(true);
  });

  test("no drift when excerpt is present in body", async () => {
    const result = await verify({
      ...baseArgs,
      client: mockClient([{ entity_id: "e1", fields: { f: "Berlin" }, evidence: { f: [{ url: "https://example.com", retrieved_at: "2026-05-11T00:00:00Z", excerpt: "founded in Berlin in 2024" }] } }]),
      refetcher: mockRefetcher(() => ({ ok: true, final_url: "https://example.com", body: "The company was founded in Berlin in 2024 by..." })),
    });
    const drifts = result.report!.drifts as any[];
    expect(drifts).toHaveLength(0);
  });

  test("fields with no source are skipped (not classified)", async () => {
    const result = await verify({
      ...baseArgs,
      client: mockClient([{ entity_id: "e1", fields: { f: "v" } /* no evidence */ }]),
      refetcher: mockRefetcher(() => ({ ok: true, final_url: "x", body: "" })),
    });
    const stats = result.report!.stats as any;
    expect(stats.fields_checked).toBe(0);
    expect(stats.drift_count).toBe(0);
  });

  test("halts on budget floor", async () => {
    let calls = 0;
    const result = await verify({
      ...baseArgs,
      budget: "0.02", // very small
      safety_floor: "0.01",
      client: mockClient([
        { entity_id: "e1", fields: { f: "v" }, evidence: { f: [{ url: "https://a.com", retrieved_at: "t" }] } },
        { entity_id: "e2", fields: { f: "v" }, evidence: { f: [{ url: "https://b.com", retrieved_at: "t" }] } },
        { entity_id: "e3", fields: { f: "v" }, evidence: { f: [{ url: "https://c.com", retrieved_at: "t" }] } },
      ]),
      refetcher: mockRefetcher((url) => {
        calls++;
        return {
          ok: true,
          final_url: url,
          body: "v",
          tool_call: {
            descriptor_id: "x",
            tool_id: "x",
            cost: "0.015",
            source_url: url,
            retrieved_at: "t",
            input_hash: "h",
          },
        };
      }),
    });
    const stats = result.report!.stats as any;
    expect(stats.halted_for_budget).toBe(true);
    expect(calls).toBeLessThanOrEqual(2); // first call consumes 0.015 of 0.02; second drops below floor
  });
});
