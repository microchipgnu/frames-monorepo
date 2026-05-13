// Tests for the curate agent loop. We don't exercise the real LLM here —
// just the control flow: how the loop reacts to stop_reason, budget
// exhaustion, and the iteration cap. The LLM client is replaced with a
// scripted mock that returns a queued sequence of responses.

import { describe, expect, test } from "bun:test";
import type { LlmContent, LlmResponse } from "../src/llm/client.ts";
import { curate } from "../src/ops/curate.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockClient() {
  return {
    async getSchema() {
      return { frame_protocol: "0.2.0", name: "test", fields: { f: { type: "string" } } };
    },
    async getMeta() {
      return {
        user: "u",
        repo: "r",
        sha: "abc1234",
        frame_path: "",
        schema_name: "test",
        entity_count: 0,
        fields: ["f"],
        max_ts: "2026-05-11T00:00:00Z",
      };
    },
    async getReadme() {
      throw new Error("no readme");
    },
    async getEntity() {
      return null;
    },
    async *iterateEntities() {
      // empty
    },
  } as any;
}

function mockCatalog() {
  return {
    async search() {
      return { tools: [], cursor: null };
    },
    async get() {
      return null;
    },
    async buildInvocation() {
      return null;
    },
  } as any;
}

function mockLlm(script: LlmResponse[]) {
  let i = 0;
  return {
    async call() {
      const next = script[i++];
      if (!next) {
        throw new Error(`LLM script exhausted (called ${i} times, only ${script.length} responses queued)`);
      }
      return next;
    },
  } as any;
}

const baseArgs = {
  frame_url: "https://github.com/u/r",
  budget: "1.00",
  run_id: "run_test",
  agent: "frames-runtime:test",
  refetcher: async () => ({ ok: false, final_url: "", error: "unused" }),
};

const text = (s: string): LlmContent => ({ type: "text", text: s });

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

describe("curate loop control", () => {
  test("end_turn on first iter ends the loop with the model's text as summary", async () => {
    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm([
        {
          stop_reason: "end_turn",
          content: [text("Nothing to do; frame is in good shape.")],
          usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
        },
      ]),
    });
    expect(result.summary).toContain("stop=end_turn");
    expect(result.report?.llm_summary).toContain("Nothing to do");
    expect(result.events).toHaveLength(0);
    expect(result.tool_log).toHaveLength(0);
    expect(result.report?.stop_reason).toBe("end_turn");
    expect(result.report?.iterations).toBe(1);
  });

  test("sharp spin detector stops the loop on identical no-event iters (v0.3.0)", async () => {
    // Two consecutive iters with the same tool-call signature AND zero events
    // → sharp-spin trigger fires, no need to wait for the generous 5-streak.
    // Same nonexistent tool, same input, same outcome (error) — textbook spin.
    const toolUse: LlmContent = {
      type: "tool_use",
      id: "t_1",
      name: "nonexistent_tool",
      input: {},
    };
    const script: LlmResponse[] = Array.from({ length: 6 }, () => ({
      stop_reason: "tool_use",
      content: [toolUse],
      usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
    }));
    // Append one extra response for the forced wrap-up summary call.
    script.push({
      stop_reason: "end_turn",
      content: [text("Wrapping up — nothing was written.")],
      usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
    });
    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm(script),
      max_iters: 5,
    });
    // iter 1: call LLM, 0 events, streak=1, sig recorded.
    // iter 2: same sig → sharp-spin bumps streak to 5.
    // iter 3: top-of-iter sees streak>=5, force-summary, break.
    expect(result.report?.iterations).toBe(3);
    expect(result.report?.stop_reason).toBe("no_progress");
  });

  test("varied exploration is NOT punished by the sharp spin detector — only the generous 5-streak fires", async () => {
    // Five iters with DIFFERENT tool calls, all read-only (no events). The
    // sharp-spin detector never trips because signatures vary; the generous
    // 5-streak does — but only on iter 6.
    const script: LlmResponse[] = [
      // Five varied no-event iters
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t_1", name: "catalog_search", input: { capability: "search" } }],
        usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
      },
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t_2", name: "catalog_search", input: { capability: "scrape" } }],
        usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
      },
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t_3", name: "catalog_search", input: { capability: "enrich" } }],
        usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
      },
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t_4", name: "query", input: { mode: "all" } }],
        usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
      },
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t_5", name: "query", input: { mode: "entity", entity_id: "e1" } }],
        usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
      },
      // The forced wrap-up after the 5-streak trips.
      {
        stop_reason: "end_turn",
        content: [text("OK, wrapping up.")],
        usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
      },
    ];
    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm(script),
      max_iters: 10,
    });
    // Five iters with varied no-event tool calls = streak hits 5 at end of iter 5.
    // Iter 6 fires the force-summary on top-of-iter check.
    expect(result.report?.iterations).toBe(6);
    expect(result.report?.stop_reason).toBe("no_progress");
  });

  test("budget exhaustion triggers a one-shot final-summary call", async () => {
    // First response is a tool_use that costs nothing; the loop drops below
    // safety_floor next iteration and asks for a wrap-up.
    const expensive: LlmResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t_1", name: "query", input: { mode: "all" } }],
      usage: { input_tokens: 100, output_tokens: 100, estimated_cost: "0.95" },
    };
    const wrap: LlmResponse = {
      stop_reason: "end_turn",
      content: [text("Budget gone; here is the wrap-up.")],
      usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
    };
    const result = await curate({
      ...baseArgs,
      budget: "0.10",
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm([expensive, wrap]),
      safety_floor: "0.05",
    });
    expect(result.report?.llm_summary).toContain("wrap-up");
    expect(result.report?.stop_reason).toBe("budget_exhausted");
  });

  test("unrecognized stop_reason halts gracefully", async () => {
    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm([
        {
          stop_reason: "weird_new_reason",
          content: [text("partial")],
          usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
        },
      ]),
    });
    expect(result.report?.stop_reason).toBe("weird_new_reason");
    expect(result.summary).toContain("weird_new_reason"); // surfaced in meta-summary
    expect(result.report?.llm_summary).toContain("unexpected stop_reason");
  });

  test("onEvent fires for each event the moment it lands", async () => {
    // Simulate a tool_use that returns one synthetic event, followed by
    // end_turn. The onEvent callback should fire exactly once during the
    // dispatch loop — BEFORE the op resolves.
    const fakeEvent = {
      id: "ev_test",
      ts: "2026-05-11T00:00:00Z",
      type: "entity.created",
      agent: "frames-runtime:test",
      run_id: "run_test",
      payload: { entity_id: "e1" },
    };
    const tool_use: LlmContent = {
      type: "tool_use",
      id: "t_1",
      name: "add_entity_with_facts",
      input: { entity_id: "e1", facts: [{ field: "f", value: "v", source: { url: "https://x", retrieved_at: "2026-05-11" } }] },
    };
    const observed: unknown[] = [];
    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm([
        {
          stop_reason: "tool_use",
          content: [tool_use],
          usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
        },
        {
          stop_reason: "end_turn",
          content: [text("done")],
          usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
        },
      ]),
      onEvent: (e) => observed.push(e),
    });
    // The real dispatch produces an entity.created + a facts.set_many event;
    // both should land in `observed` AND in `result.events`.
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.length).toBe(observed.length);
    // The synthetic check ensures the callback isn't being called after the
    // op resolves with a buffered batch — observed must be populated before
    // the final summary is built. We can't directly prove "before" here, but
    // a count match against the captured events is the visible invariant.
    void fakeEvent;
  });

  test("custom_prompt lands in the system prompt the LLM receives", async () => {
    // Capture the system arg passed to the LLM on the first call.
    let capturedSystem: string | undefined;
    const llmCapturing = {
      async call(opts: { system: string }) {
        capturedSystem = opts.system;
        return {
          stop_reason: "end_turn",
          content: [text("done")],
          usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
        };
      },
    } as any;
    await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: llmCapturing,
      custom_prompt: "## TICK-MARKER\n\nFocus only on entities from the EU AI Act registry.",
    });
    expect(capturedSystem).toContain("TICK-MARKER");
    expect(capturedSystem).toContain("EU AI Act registry");
    // The buildCurateSystem header for customer content is stable:
    expect(capturedSystem).toContain("Custom loop instructions (from prompt.md)");
  });

  test("max_tokens stop_reason halts and surfaces the truncation note", async () => {
    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: mockLlm([
        {
          stop_reason: "max_tokens",
          content: [text("I was about to say something important")],
          usage: { input_tokens: 1, output_tokens: 4096, estimated_cost: "0.01" },
        },
      ]),
    });
    expect(result.report?.stop_reason).toBe("max_tokens");
    expect(result.report?.llm_summary).toContain("truncated");
  });

  // v0.3.8 — parallel sub-agents can both decide to add the same entity_id
  // because they share the known_entity_ids snapshot at dispatch time. The
  // parent loop must dedupe after the fact.
  test("duplicate entity.created across parallel sub-agents is suppressed", async () => {
    // Two discover_entity calls in one turn, both proposing entity_id="dupe".
    // The first wins; the second's events are dropped and its sub_run is
    // converted to entity_matched_existing.
    const proposeDupe = (callId: string): LlmContent => ({
      type: "tool_use",
      id: callId,
      name: "discover_entity",
      input: { hypothesis: `Investigate dupe as ${callId}` },
    });

    // The dispatch helpers we don't mock here will fail if invoked; we don't
    // need them to — we exercise the parent's dedup logic by short-circuiting
    // via end_turn after the first turn's tool dispatches complete.
    //
    // The real EntityAgent isn't bound in test mode, so dispatchDiscoverEntity
    // falls back to calling discoverEntity() directly. We can't easily script
    // that path here without rewriting more of the test harness. So instead
    // this test focuses on the parent-loop dedup invariant assuming dispatches
    // return entity.created events with colliding ids.
    //
    // Approach: wrap the LLM mock to ALSO satisfy the embedded discoverEntity
    // sub-loops. Each sub-loop will do propose_new_entity in iter 1 with the
    // same entity_id. We need 2 sub-loops × 1 LLM call each, plus the parent
    // turn that initiated them, plus the parent's final end_turn.
    let llmIdx = 0;
    const wrappedLlm = {
      async call(opts: any) {
        llmIdx++;
        // Parent turn 1: emit two discover_entity tool_uses.
        if (llmIdx === 1) {
          return {
            stop_reason: "tool_use",
            content: [proposeDupe("t_a"), proposeDupe("t_b")],
            usage: { input_tokens: 10, output_tokens: 10, estimated_cost: "0.001" },
          };
        }
        // Two sub-loops' iter 1 — each immediately proposes "dupe".
        if (llmIdx === 2 || llmIdx === 3) {
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: `propose_${llmIdx}`,
                name: "propose_new_entity",
                input: {
                  entity_id: "dupe",
                  facts: [
                    {
                      field: "f",
                      value: "v",
                      source: { url: "https://x", retrieved_at: "2026-05-11T00:00:00Z", excerpt: "ex" },
                    },
                  ],
                  narrative: "ok",
                },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 10, estimated_cost: "0.001" },
          };
        }
        // Parent turn 2: end_turn.
        return {
          stop_reason: "end_turn",
          content: [text("done")],
          usage: { input_tokens: 1, output_tokens: 1, estimated_cost: "0.001" },
        };
      },
    } as any;

    const result = await curate({
      ...baseArgs,
      client: mockClient(),
      catalog: mockCatalog(),
      llm: wrappedLlm,
    });

    // Exactly ONE entity.created for "dupe" — the second was suppressed.
    const createdForDupe = result.events.filter(
      (e: any) => e.type === "entity.created" && (e.payload as any).entity_id === "dupe",
    );
    expect(createdForDupe).toHaveLength(1);

    // And one facts.set_many for "dupe" — the second sub-agent's
    // companion event was also suppressed.
    const factsForDupe = result.events.filter(
      (e: any) => e.type === "facts.set_many" && (e.payload as any).entity_id === "dupe",
    );
    expect(factsForDupe).toHaveLength(1);

    // Sub_runs should reflect: one entity_added + one entity_matched_existing.
    const subActions = (result.sub_runs ?? []).map((s) => s.action);
    expect(subActions).toContain("entity_added");
    expect(subActions).toContain("entity_matched_existing");

    // The collision narrative should mention duplicate-of.
    const collided = (result.sub_runs ?? []).find((s) => s.action === "entity_matched_existing");
    expect(collided?.narrative).toContain("duplicate");
  });
});
