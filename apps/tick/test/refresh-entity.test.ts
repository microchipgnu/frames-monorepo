// refresh-entity sub-loop tests. Today's coverage: the Phase E.1 fetch
// dedup. Other behaviors (terminal tools, budget guard, max_iters cap)
// are covered transitively via curate.test.ts; this file targets the
// cache-marker invariant directly.

import { describe, expect, test } from "bun:test";
import type { LlmContent, LlmResponse } from "../src/llm/client.ts";
import { refreshEntity } from "../src/ops/refresh-entity.ts";
import type { Refetcher } from "../src/ops/types.ts";

function mockLlm(script: LlmResponse[]) {
  let i = 0;
  return {
    async call() {
      const next = script[i++];
      if (!next) throw new Error(`script exhausted at call ${i}, ${script.length} responses queued`);
      return next;
    },
  } as any;
}

const baseSchema = {
  frame_protocol: "0.2.0",
  name: "test",
  fields: { name: { type: "string", required: true } },
} as any;

const text = (s: string): LlmContent => ({ type: "text", text: s });

describe("refreshEntity — Phase E.1 fetch dedup", () => {
  test("re-fetching the same URL hits the cache, not the network", async () => {
    // Refetcher invariant: it fires exactly ONCE despite the model
    // emitting web_fetch twice for the same URL across two iters.
    let refetchCalls = 0;
    const trackingRefetcher: Refetcher = async ({ url }) => {
      refetchCalls++;
      return {
        ok: true,
        final_url: url,
        body: "<html>Page body containing a name fact for this entity.</html>",
      };
    };

    // Iter 1: web_fetch A (cache miss, refetcher fires).
    // Iter 2: web_fetch A again (cache hit, no refetcher) + propose_facts.
    //   The terminal propose_facts breaks the outer loop, so the
    //   nonTerminalStreak guard never trips.
    const fetchOnly: LlmResponse = {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t_1", name: "web_fetch", input: { url: "https://example.com/foo" } },
      ],
      usage: { input_tokens: 10, output_tokens: 10, estimated_cost: "0.001" },
    };
    const summary: LlmResponse = {
      stop_reason: "end_turn",
      content: [text("(schema-relevant summary of example.com/foo)")],
      usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
    };
    const refetchAndPropose: LlmResponse = {
      stop_reason: "tool_use",
      content: [
        // Same URL — should hit the cache populated by iter 1.
        { type: "tool_use", id: "t_2a", name: "web_fetch", input: { url: "https://example.com/foo" } },
        {
          type: "tool_use",
          id: "t_2b",
          name: "propose_facts",
          input: {
            facts: [
              {
                field: "name",
                value: "Example Entity",
                source: { url: "https://example.com/foo", retrieved_at: "2026-05-13T00:00:00Z", excerpt: "Example Entity is a thing." },
              },
            ],
            narrative: "Verified from cached source.",
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
    };

    const result = await refreshEntity({
      entity_id: "ent_a",
      entity_state: { entity_id: "ent_a", fields: {}, evidence: {} },
      schema: baseSchema,
      llm: mockLlm([
        fetchOnly,
        summary, // summarizer runs ONCE after iter 1's cache-miss fetch
        refetchAndPropose,
      ]),
      refetcher: trackingRefetcher,
      budget: "1.00",
      max_iters: 5,
      run_id: "run_test",
      agent: "frames-runtime:test",
    } as any);

    expect(result.stop_reason).toBe("wrote_facts");
    expect(result.facts_to_set).toHaveLength(1);

    // Phase E.1 invariant: one network fetch, even with two tool_use calls.
    expect(refetchCalls).toBe(1);

    // Two LLM iters total. If the cache had missed in iter 2, we'd have
    // needed a second summarizer response and the script would have
    // exhausted.
    expect(result.iteration_log).toHaveLength(2);
  });

  test("different entity_hint on the same URL is treated as distinct (no false cache hit)", async () => {
    // Cache key includes entity_hint — two fetches of the same URL with
    // different hints both hit the network. Tested in a single iter to
    // sidestep the nonTerminalStreak guard.
    let refetchCalls = 0;
    const trackingRefetcher: Refetcher = async ({ url }) => {
      refetchCalls++;
      return { ok: true, final_url: url, body: "<html>page</html>" };
    };
    const summary: LlmResponse = {
      stop_reason: "end_turn",
      content: [text("summary")],
      usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
    };
    const twoFetchesDifferentHintsThenDone: LlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t_foo",
          name: "web_fetch",
          input: { url: "https://example.com/x", entity_hint: "foo" },
        },
        {
          type: "tool_use",
          id: "t_bar",
          name: "web_fetch",
          input: { url: "https://example.com/x", entity_hint: "bar" },
        },
        {
          type: "tool_use",
          id: "t_done",
          name: "no_change",
          input: { narrative: "OK" },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
    };

    const result = await refreshEntity({
      entity_id: "ent_a",
      entity_state: { entity_id: "ent_a", fields: {}, evidence: {} },
      schema: baseSchema,
      llm: mockLlm([
        twoFetchesDifferentHintsThenDone,
        summary, // for fetch with hint=foo
        summary, // for fetch with hint=bar
      ]),
      refetcher: trackingRefetcher,
      budget: "1.00",
      max_iters: 5,
      run_id: "run_test",
      agent: "frames-runtime:test",
    } as any);

    expect(result.stop_reason).toBe("no_change");
    // Two distinct cache keys → two refetcher invocations.
    expect(refetchCalls).toBe(2);
  });
});
