// discoverEntity sub-loop tests. We mock the LLM with a scripted sequence
// that drives the sub-loop through each terminal-tool path:
//   - propose_new_entity (success: parent gets a new entity to add)
//   - propose_match_existing (dupe: parent ignores)
//   - no_match (rejected: parent ignores)
//   - hitting known_entity_ids guard on propose_new_entity (re-prompt path)

import { describe, expect, test } from "bun:test";
import type { LlmContent, LlmResponse } from "../src/llm/client.ts";
import { discoverEntity } from "../src/ops/discover-entity.ts";
import type { Refetcher } from "../src/ops/types.ts";

function mockLlm(script: LlmResponse[]) {
  let i = 0;
  return {
    async call() {
      const next = script[i++];
      if (!next) throw new Error(`script exhausted at call ${i}, only ${script.length} responses queued`);
      return next;
    },
  } as any;
}

const mockRefetcher: Refetcher = async ({ url }) => ({
  ok: true,
  final_url: url,
  body: `<html><body>Page body for ${url} containing relevant entity context.</body></html>`,
});

const baseSchema = {
  frame_protocol: "0.2.0",
  name: "biotechs",
  entity_type: "company",
  fields: {
    name: { type: "string", required: true },
    founded_year: { type: "integer" },
    hq_country: { type: "string" },
  },
} as any;

const baseArgs = {
  schema: baseSchema,
  refetcher: mockRefetcher,
  budget: "0.30",
  max_iters: 5,
  run_id: "run_test",
  agent: "frames-runtime:test",
};

const text = (s: string): LlmContent => ({ type: "text", text: s });

describe("discoverEntity", () => {
  test("propose_new_entity success: returns proposed_entity + entity_proposed stop_reason", async () => {
    const result = await discoverEntity({
      ...baseArgs,
      hypothesis: "A biotech called Genomique, Paris, founded 2024.",
      known_entity_ids: ["acme-bio", "biocorp"],
      llm: mockLlm([
        // iter 1: model proposes the new entity directly (no fetches in this path)
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "t_1",
              name: "propose_new_entity",
              input: {
                entity_id: "genomique",
                facts: [
                  {
                    field: "name",
                    value: "Genomique",
                    source: { url: "https://example.com", retrieved_at: "2026-05-13T00:00:00Z", excerpt: "Genomique is a Paris biotech." },
                  },
                  {
                    field: "founded_year",
                    value: 2024,
                    source: { url: "https://example.com", retrieved_at: "2026-05-13T00:00:00Z", excerpt: "Founded in 2024." },
                  },
                ],
                narrative: "Verified via primary source.",
              },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
        },
      ]),
    } as any);
    expect(result.stop_reason).toBe("entity_proposed");
    expect(result.proposed_entity?.entity_id).toBe("genomique");
    expect(result.proposed_entity?.facts).toHaveLength(2);
    expect(result.matched_existing_entity_id).toBeUndefined();
    expect(result.narrative).toContain("Verified");
  });

  test("propose_match_existing: returns matched_existing_entity_id, no proposal", async () => {
    const result = await discoverEntity({
      ...baseArgs,
      hypothesis: "Maybe a biotech called Acme",
      known_entity_ids: ["acme-bio", "biocorp"],
      llm: mockLlm([
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "t_1",
              name: "propose_match_existing",
              input: {
                entity_id: "acme-bio",
                narrative: "Acme is acme-bio under a shorter name.",
              },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
        },
      ]),
    } as any);
    expect(result.stop_reason).toBe("matched_existing");
    expect(result.matched_existing_entity_id).toBe("acme-bio");
    expect(result.proposed_entity).toBeUndefined();
  });

  test("no_match: returns no proposal, stop_reason no_match", async () => {
    const result = await discoverEntity({
      ...baseArgs,
      hypothesis: "A fictional biotech that probably doesn't exist",
      known_entity_ids: [],
      llm: mockLlm([
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "t_1",
              name: "no_match",
              input: { narrative: "No primary sources found; rejecting hypothesis." },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
        },
      ]),
    } as any);
    expect(result.stop_reason).toBe("no_match");
    expect(result.proposed_entity).toBeUndefined();
    expect(result.matched_existing_entity_id).toBeUndefined();
  });

  test("known_entity_ids guard: proposing a duplicate id forces a retry, not silent acceptance", async () => {
    const result = await discoverEntity({
      ...baseArgs,
      hypothesis: "Maybe a biotech called Acme",
      known_entity_ids: ["acme-bio"],
      llm: mockLlm([
        // iter 1: model wrongly proposes the duplicate id — the dispatcher
        // rejects via tool_result error, sub-loop continues.
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "t_1",
              name: "propose_new_entity",
              input: {
                entity_id: "acme-bio",
                facts: [],
                narrative: "tried to add",
              },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
        },
        // iter 2: model recovers by calling propose_match_existing
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "t_2",
              name: "propose_match_existing",
              input: { entity_id: "acme-bio", narrative: "Same entity." },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 50, estimated_cost: "0.001" },
        },
      ]),
    } as any);
    expect(result.stop_reason).toBe("matched_existing");
    expect(result.matched_existing_entity_id).toBe("acme-bio");
    expect(result.iteration_log).toHaveLength(2);
  });

  test("evidence-aware early stop: 3 consecutive non-decisive iters → stop with no_progress (v0.3.1+)", async () => {
    // The sub-loop runs web_fetch three times without ever calling a
    // terminal tool. nonTerminalStreak fires on iter 4's top-of-iter check.
    // Threshold raised from 2 to 3 in v0.3.1 after a live curate showed
    // 13/17 discover sub-loops were getting killed before they could
    // propose — the typical pattern is fetch → fetch → propose (3 iters).
    const fetchOnly = (id: string): LlmResponse => ({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id,
          name: "web_fetch",
          input: { url: `https://example.com/${id}` },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10, estimated_cost: "0.001" },
    });
    const summarizerResponse: LlmResponse = {
      stop_reason: "end_turn",
      content: [text("(schema summary)")],
      usage: { input_tokens: 10, output_tokens: 10, estimated_cost: "0.0001" },
    };
    const result = await discoverEntity({
      ...baseArgs,
      hypothesis: "Random hypothesis",
      known_entity_ids: [],
      llm: mockLlm([
        fetchOnly("a"),
        summarizerResponse,
        fetchOnly("b"),
        summarizerResponse,
        fetchOnly("c"),
        summarizerResponse,
      ]),
    } as any);
    expect(result.stop_reason).toBe("no_progress");
    expect(result.iteration_log).toHaveLength(3);
  });
});
