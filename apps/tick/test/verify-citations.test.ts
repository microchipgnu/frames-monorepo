// CitationAgent post-pass tests. Mock the LLM to return supported/unsupported
// verdicts and confirm:
//   1. Each fact with an excerpt triggers one Haiku call.
//   2. Unsupported verdicts produce fact.deprecated events keyed by fact_id.
//   3. Supported verdicts produce no new events.
//   4. Facts without excerpts are skipped (not deprecated).
//   5. LLM exceptions inside the verifier don't crash the run.

import { describe, expect, test } from "bun:test";
import type { FrameEvent } from "@frames-ag/tick-types";
import { verifyCitations } from "../src/ops/verify-citations.ts";

function mockJudge(verdicts: Array<{ supported: boolean; reason: string }>) {
  let i = 0;
  return {
    async call() {
      const next = verdicts[i++];
      if (!next) throw new Error("judge script exhausted");
      return {
        stop_reason: "end_turn",
        model: "anthropic/claude-haiku-4-5",
        content: [
          {
            type: "text",
            text: JSON.stringify({ supported: next.supported, reason: next.reason }),
          },
        ],
        usage: { input_tokens: 80, output_tokens: 20, estimated_cost: "0.0003" },
      };
    },
  } as any;
}

function setManyEvent(entity_id: string, facts: Array<{ fact_id: string; field: string; value: unknown; excerpt: string }>): FrameEvent {
  return {
    id: "ev_1",
    ts: "2026-05-13T00:00:00Z",
    type: "facts.set_many",
    agent: "frames-runtime:test",
    run_id: "run_test",
    payload: {
      entity_id,
      facts: facts.map((f) => ({
        fact_id: f.fact_id,
        field: f.field,
        value: f.value,
        source: { url: "https://x.com", retrieved_at: "2026-05-13T00:00:00Z", excerpt: f.excerpt },
      })),
    },
  };
}

describe("verifyCitations", () => {
  test("supported claim emits no deprecation", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_1", field: "founded_year", value: 2018, excerpt: "Founded in 2018 in Berlin." },
      ]),
    ];
    const result = await verifyCitations({
      events,
      llm: mockJudge([{ supported: true, reason: "Excerpt explicitly states founding year." }]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(0);
    expect(result.summary.supported).toBe(1);
    expect(result.summary.unsupported).toBe(0);
    expect(result.summary.skipped_no_excerpt).toBe(0);
  });

  test("unsupported claim emits one fact.deprecated keyed by fact_id", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_abc", field: "ceo", value: "Alice", excerpt: "Bob took over as CEO in 2024." },
      ]),
    ];
    const result = await verifyCitations({
      events,
      llm: mockJudge([{ supported: false, reason: "Excerpt names Bob, not Alice." }]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(1);
    expect(result.deprecation_events[0]!.type).toBe("fact.deprecated");
    const payload = result.deprecation_events[0]!.payload as { fact_id: string; reason: string };
    expect(payload.fact_id).toBe("fact_abc");
    expect(payload.reason).toContain("citation_unverified");
    expect(payload.reason).toContain("Bob");
    expect(result.summary.unsupported).toBe(1);
  });

  test("facts without an excerpt are skipped, not deprecated", async () => {
    const events: FrameEvent[] = [
      {
        id: "ev_1",
        ts: "2026-05-13T00:00:00Z",
        type: "facts.set_many",
        agent: "frames-runtime:test",
        run_id: "run_test",
        payload: {
          entity_id: "e1",
          facts: [
            {
              fact_id: "fact_no_excerpt",
              field: "name",
              value: "x",
              source: { url: "https://x.com", retrieved_at: "2026-05-13T00:00:00Z" },
            },
          ],
        },
      },
    ];
    const result = await verifyCitations({
      events,
      llm: mockJudge([]), // should never be called
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(0);
    expect(result.summary.skipped_no_excerpt).toBe(1);
    expect(result.summary.facts_checked).toBe(0);
  });

  test("walks facts.set_many AND fact.set events", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_1", field: "a", value: 1, excerpt: "Some excerpt about a=1." },
      ]),
      {
        id: "ev_2",
        ts: "2026-05-13T00:00:00Z",
        type: "fact.set",
        agent: "frames-runtime:test",
        run_id: "run_test",
        payload: {
          fact_id: "fact_2",
          entity_id: "e1",
          field: "b",
          value: 2,
          source: { url: "https://x.com", retrieved_at: "2026-05-13T00:00:00Z", excerpt: "b is 2." },
        },
      },
    ];
    const result = await verifyCitations({
      events,
      llm: mockJudge([
        { supported: true, reason: "fact 1 supported" },
        { supported: false, reason: "fact 2 unsupported" },
      ]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.summary.facts_checked).toBe(2);
    expect(result.deprecation_events).toHaveLength(1);
    expect((result.deprecation_events[0]!.payload as { fact_id: string }).fact_id).toBe("fact_2");
  });

  test("fallback parser extracts supported=true from a code-fenced response", async () => {
    const fencedLlm = {
      async call() {
        return {
          stop_reason: "end_turn",
          model: "anthropic/claude-haiku-4-5",
          content: [
            {
              type: "text",
              text: '```json\n{"supported": true, "reason": "matches"}\n```',
            },
          ],
          usage: { input_tokens: 80, output_tokens: 20, estimated_cost: "0.0003" },
        };
      },
    } as any;
    const events: FrameEvent[] = [
      setManyEvent("e1", [{ fact_id: "f1", field: "x", value: 1, excerpt: "x is 1" }]),
    ];
    const result = await verifyCitations({
      events,
      llm: fencedLlm,
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.summary.supported).toBe(1);
    expect(result.deprecation_events).toHaveLength(0);
  });
});
