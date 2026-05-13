// CitationAgent post-pass tests. v0.4.2: verifier now batches multiple
// facts into ONE Haiku call to avoid rate-limiting. Mocks return a
// batched-shape response keyed by fact_id.

import { describe, expect, test } from "bun:test";
import type { FrameEvent } from "@frames-ag/tick-types";
import { parseBatchJudgements, verifyCitations } from "../src/ops/verify-citations.ts";

interface MockBatchEntry {
  fact_id: string;
  supported: boolean;
  reason: string;
}

/**
 * Mock LLM that returns ONE batched response per call. Each call consumes
 * the next array in the script — one array = one batch's judgements.
 */
function mockBatchedJudge(batches: MockBatchEntry[][]) {
  let i = 0;
  return {
    async call() {
      const next = batches[i++];
      if (!next) throw new Error("judge batch script exhausted");
      return {
        stop_reason: "end_turn",
        model: "anthropic/claude-haiku-4-5",
        content: [
          {
            type: "text",
            text: JSON.stringify({ judgements: next }),
          },
        ],
        usage: {
          input_tokens: 80 + next.length * 50,
          output_tokens: next.length * 30,
          estimated_cost: (next.length * 0.00003).toFixed(6),
        },
      };
    },
  } as any;
}

function setManyEvent(
  entity_id: string,
  facts: Array<{ fact_id: string; field: string; value: unknown; excerpt: string }>,
): FrameEvent {
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

describe("verifyCitations — batched shape (v0.4.2+)", () => {
  test("single batch: all supported → zero deprecations", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_1", field: "founded_year", value: 2018, excerpt: "Founded in 2018 in Berlin." },
        { fact_id: "fact_2", field: "language", value: "Python", excerpt: "Built in Python." },
      ]),
    ];
    const result = await verifyCitations({
      events,
      llm: mockBatchedJudge([
        [
          { fact_id: "fact_1", supported: true, reason: "Excerpt explicitly states year." },
          { fact_id: "fact_2", supported: true, reason: "Excerpt explicitly states language." },
        ],
      ]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(0);
    expect(result.summary.supported).toBe(2);
    expect(result.summary.unsupported).toBe(0);
    expect(result.summary.facts_checked).toBe(2);
  });

  test("single batch with mixed verdicts: one deprecation emitted", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_supported", field: "name", value: "FastMCP", excerpt: "Project name: FastMCP." },
        { fact_id: "fact_failed", field: "ceo", value: "Alice", excerpt: "Bob took over as CEO in 2024." },
      ]),
    ];
    const result = await verifyCitations({
      events,
      llm: mockBatchedJudge([
        [
          { fact_id: "fact_supported", supported: true, reason: "Match" },
          { fact_id: "fact_failed", supported: false, reason: "Excerpt names Bob, not Alice." },
        ],
      ]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(1);
    const payload = result.deprecation_events[0]!.payload as { fact_id: string; reason: string };
    expect(payload.fact_id).toBe("fact_failed");
    expect(payload.reason).toContain("citation_unverified");
    expect(payload.reason).toContain("Bob");
  });

  test("ONE LLM call per batch (not per fact) — verified via iteration_log length", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "f1", field: "a", value: 1, excerpt: "1" },
        { fact_id: "f2", field: "b", value: 2, excerpt: "2" },
        { fact_id: "f3", field: "c", value: 3, excerpt: "3" },
        { fact_id: "f4", field: "d", value: 4, excerpt: "4" },
        { fact_id: "f5", field: "e", value: 5, excerpt: "5" },
      ]),
    ];
    const result = await verifyCitations({
      events,
      llm: mockBatchedJudge([
        [
          { fact_id: "f1", supported: true, reason: "ok" },
          { fact_id: "f2", supported: true, reason: "ok" },
          { fact_id: "f3", supported: true, reason: "ok" },
          { fact_id: "f4", supported: true, reason: "ok" },
          { fact_id: "f5", supported: true, reason: "ok" },
        ],
      ]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.iteration_log).toHaveLength(1); // 5 facts, 1 LLM call
    expect(result.summary.facts_checked).toBe(5);
    expect(result.summary.supported).toBe(5);
  });

  test("facts without excerpts are skipped, never sent to LLM", async () => {
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
      llm: mockBatchedJudge([]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(0);
    expect(result.summary.skipped_no_excerpt).toBe(1);
    expect(result.summary.facts_checked).toBe(0);
    expect(result.iteration_log).toHaveLength(0);
  });

  test("multi-batch: 35 facts span TWO LLM calls (BATCH_SIZE=30)", async () => {
    const factCount = 35;
    const facts = Array.from({ length: factCount }, (_, i) => ({
      fact_id: `fact_${i}`,
      field: "x",
      value: i,
      excerpt: `excerpt ${i}`,
    }));
    const batch1 = facts.slice(0, 30).map((f) => ({
      fact_id: f.fact_id,
      supported: true,
      reason: "ok",
    }));
    const batch2 = facts.slice(30).map((f) => ({
      fact_id: f.fact_id,
      supported: true,
      reason: "ok",
    }));
    const result = await verifyCitations({
      events: [setManyEvent("e1", facts)],
      llm: mockBatchedJudge([batch1, batch2]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.iteration_log).toHaveLength(2);
    expect(result.summary.supported).toBe(35);
    expect(result.summary.facts_checked).toBe(35);
  });

  test("missing fact in Haiku response → conservatively treated as supported", async () => {
    // Haiku returns judgements for fact_1 and fact_3 but skips fact_2.
    // We want fact_2 to NOT be deprecated — graceful degradation.
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_1", field: "a", value: 1, excerpt: "a is 1" },
        { fact_id: "fact_2", field: "b", value: 2, excerpt: "b is 2" },
        { fact_id: "fact_3", field: "c", value: 3, excerpt: "c is 3" },
      ]),
    ];
    const result = await verifyCitations({
      events,
      llm: mockBatchedJudge([
        [
          { fact_id: "fact_1", supported: true, reason: "ok" },
          // fact_2 missing
          { fact_id: "fact_3", supported: true, reason: "ok" },
        ],
      ]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.deprecation_events).toHaveLength(0);
    // All 3 counted as supported (one explicitly, one falling back)
    expect(result.summary.supported).toBe(3);
  });

  test("walks BOTH facts.set_many AND fact.set events", async () => {
    const events: FrameEvent[] = [
      setManyEvent("e1", [
        { fact_id: "fact_1", field: "a", value: 1, excerpt: "a=1" },
      ]),
      {
        id: "ev_2",
        ts: "2026-05-13T00:00:00Z",
        type: "fact.set",
        agent: "frames-runtime:test",
        run_id: "run_test",
        payload: {
          fact_id: "fact_2",
          entity_id: "e2",
          field: "b",
          value: 2,
          source: { url: "https://x.com", retrieved_at: "2026-05-13T00:00:00Z", excerpt: "b=2" },
        },
      },
    ];
    const result = await verifyCitations({
      events,
      llm: mockBatchedJudge([
        [
          { fact_id: "fact_1", supported: true, reason: "ok" },
          { fact_id: "fact_2", supported: false, reason: "no" },
        ],
      ]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.summary.facts_checked).toBe(2);
    expect(result.deprecation_events).toHaveLength(1);
    expect((result.deprecation_events[0]!.payload as { fact_id: string }).fact_id).toBe("fact_2");
  });

  test("zero verifiable facts → no LLM calls", async () => {
    // All events have no facts, OR all facts have no excerpt.
    const result = await verifyCitations({
      events: [],
      llm: mockBatchedJudge([]),
      run_id: "run_test",
      agent: "frames-runtime:test",
    });
    expect(result.iteration_log).toHaveLength(0);
    expect(result.deprecation_events).toHaveLength(0);
    expect(result.summary.facts_checked).toBe(0);
  });
});

describe("parseBatchJudgements unit tests", () => {
  const facts = [
    { fact_id: "a", entity_id: "e", field: "f", value: 1, excerpt: "x" },
    { fact_id: "b", entity_id: "e", field: "f", value: 2, excerpt: "x" },
  ];

  test("strict JSON parses cleanly", () => {
    const text = '{"judgements":[{"fact_id":"a","supported":true,"reason":"ok"},{"fact_id":"b","supported":false,"reason":"no"}]}';
    const r = parseBatchJudgements(text, facts);
    expect(r).toHaveLength(2);
    expect(r[0]!.supported).toBe(true);
    expect(r[1]!.supported).toBe(false);
  });

  test("code-fence wrapper is tolerated", () => {
    const text = '```json\n{"judgements":[{"fact_id":"a","supported":true,"reason":"ok"}]}\n```';
    const r = parseBatchJudgements(text, facts);
    expect(r).toHaveLength(1);
  });

  test("extra prose around JSON is tolerated via brace-recovery", () => {
    const text = 'Here are the judgements:\n{"judgements":[{"fact_id":"a","supported":true,"reason":"ok"}]}\nDone!';
    const r = parseBatchJudgements(text, facts);
    expect(r).toHaveLength(1);
    expect(r[0]!.fact_id).toBe("a");
  });

  test("unknown fact_ids in response are filtered out", () => {
    const text = '{"judgements":[{"fact_id":"a","supported":true,"reason":"ok"},{"fact_id":"unknown","supported":false,"reason":"hi"}]}';
    const r = parseBatchJudgements(text, facts);
    expect(r).toHaveLength(1);
    expect(r[0]!.fact_id).toBe("a");
  });

  test("malformed JSON returns empty array", () => {
    expect(parseBatchJudgements("not json at all", facts)).toEqual([]);
  });

  test("truncates reasons to 200 chars", () => {
    const longReason = "x".repeat(500);
    const text = JSON.stringify({
      judgements: [{ fact_id: "a", supported: true, reason: longReason }],
    });
    const r = parseBatchJudgements(text, facts);
    expect(r[0]!.reason.length).toBe(200);
  });
});
