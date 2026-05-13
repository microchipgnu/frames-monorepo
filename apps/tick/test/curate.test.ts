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

  test("no_progress early-stop catches the loop before max_iters when no events are emitted", async () => {
    // Build a script of responses that each request a (fake) tool call the
    // loop will fail to dispatch — no events emitted. Phase E (v0.2.0) adds
    // an evidence-aware early stop: 3 consecutive iters with no events
    // triggers a force-summary call. So even with max_iters=5, this run
    // stops at iter 4 with stop_reason=no_progress.
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
    expect(result.report?.iterations).toBe(4);
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
});
