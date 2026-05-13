// summarize.ts — v0.3.13 structured-output behavior. Tests cover:
//   1. Happy path: Haiku returns valid JSON, summarizer returns `extracted`
//      + a rendered string surface
//   2. Code-fenced JSON is tolerated
//   3. Missing fields in Haiku output → null (not dropped)
//   4. Malformed JSON → falls back to raw text in summary, ok=false
//   5. LLM exception → fallback HTML strip path, ok=false
//   6. Numeric values preserved as numbers, not stringified

import { describe, expect, test } from "bun:test";
import { summarizeForContext, tryParseExtraction } from "../src/llm/summarize.ts";

const baseSchema = {
  frame_protocol: "0.2.0",
  name: "mcp-servers",
  fields: {
    name: { type: "string", required: true },
    stars: { type: "int" },
    language: { type: "string" },
    category: { type: "enum", values: ["bridge", "browser", "data"] },
  },
} as any;

function mockLlm(responses: string[]) {
  let i = 0;
  return {
    async call() {
      const text = responses[i++];
      if (text === undefined) throw new Error("script exhausted");
      return {
        stop_reason: "end_turn",
        model: "anthropic/claude-haiku-4-5",
        content: [{ type: "text", text }],
        usage: { input_tokens: 800, output_tokens: 200, estimated_cost: "0.001" },
      };
    },
  } as any;
}

function mockLlmThrowing(err: Error) {
  return {
    async call() { throw err; },
  } as any;
}

describe("summarizeForContext — structured-output", () => {
  test("happy path: Haiku JSON → ExtractedFields + rendered summary", async () => {
    const haikuJson = JSON.stringify({
      fields: {
        name: { value: "fastmcp", excerpt: "Repository name: fastmcp" },
        stars: { value: 7212, excerpt: "7,212 stars" },
        language: { value: "Python", excerpt: "Python · 95.3%" },
        category: null,
      },
      notes: "GitHub repo page for FastMCP",
    });
    const result = await summarizeForContext({
      body: "<html><body>fastmcp 7212 stars Python</body></html>",
      schema: baseSchema,
      source_url: "https://github.com/jlowin/fastmcp",
      entity_hint: "fastmcp",
      llm: mockLlm([haikuJson]),
    });
    expect(result.ok).toBe(true);
    expect(result.extracted).toBeDefined();
    expect(result.extracted!.fields.stars).toEqual({ value: 7212, excerpt: "7,212 stars" });
    expect(result.extracted!.fields.category).toBeNull();
    expect(result.extracted!.notes).toBe("GitHub repo page for FastMCP");
    // The rendered string still goes to the agent — should contain the values.
    expect(result.summary).toContain("stars: 7212");
    expect(result.summary).toContain("language: \"Python\"");
    expect(result.summary).toContain("category: (not found in source)");
    expect(result.summary).toContain("[Source: https://github.com/jlowin/fastmcp]");
  });

  test("code-fenced JSON is tolerated", async () => {
    const fenced = "```json\n" + JSON.stringify({
      fields: { name: { value: "x", excerpt: "name x" }, stars: null, language: null, category: null },
    }) + "\n```";
    const result = await summarizeForContext({
      body: "page",
      schema: baseSchema,
      source_url: "https://example.com",
      llm: mockLlm([fenced]),
    });
    expect(result.ok).toBe(true);
    expect(result.extracted!.fields.name).toEqual({ value: "x", excerpt: "name x" });
  });

  test("missing field key in Haiku output → null (not dropped)", async () => {
    // Haiku omits the `category` key entirely. Parser fills it as null.
    const partial = JSON.stringify({
      fields: { name: { value: "x", excerpt: "x" } },
    });
    const result = await summarizeForContext({
      body: "page",
      schema: baseSchema,
      source_url: "https://example.com",
      llm: mockLlm([partial]),
    });
    expect(result.ok).toBe(true);
    expect(result.extracted!.fields).toHaveProperty("category");
    expect(result.extracted!.fields.category).toBeNull();
    expect(result.extracted!.fields.stars).toBeNull();
  });

  test("numeric values preserved as numbers", async () => {
    const haikuJson = JSON.stringify({
      fields: {
        name: null,
        stars: { value: 42, excerpt: "42 stars" },
        language: null,
        category: null,
      },
    });
    const result = await summarizeForContext({
      body: "x",
      schema: baseSchema,
      source_url: "https://example.com",
      llm: mockLlm([haikuJson]),
    });
    expect(typeof result.extracted!.fields.stars!.value).toBe("number");
    expect(result.extracted!.fields.stars!.value).toBe(42);
  });

  test("malformed JSON → fallback path, ok=false, raw text in summary", async () => {
    const result = await summarizeForContext({
      body: "page content",
      schema: baseSchema,
      source_url: "https://example.com",
      llm: mockLlm(["this is not JSON at all"]),
    });
    expect(result.ok).toBe(false);
    expect(result.extracted).toBeUndefined();
    expect(result.summary).toContain("structured parse failed");
    expect(result.summary).toContain("this is not JSON at all");
  });

  test("LLM exception → fallback HTML-strip path, ok=false", async () => {
    const result = await summarizeForContext({
      body: "<html><body>Some text content here</body></html>",
      schema: baseSchema,
      source_url: "https://example.com",
      llm: mockLlmThrowing(new Error("anthropic 529 overloaded")),
    });
    expect(result.ok).toBe(false);
    expect(result.extracted).toBeUndefined();
    expect(result.summary).toContain("Summarizer failed: anthropic 529 overloaded");
    expect(result.summary).toContain("Some text content here");
  });

  test("Haiku entry without `value` field → treated as null", async () => {
    // Defensive — Haiku occasionally writes `{ "excerpt": "..." }` without a value.
    const badJson = JSON.stringify({
      fields: {
        name: { value: "x", excerpt: "x" },
        stars: { excerpt: "saw it but no number" }, // no value
        language: null,
        category: null,
      },
    });
    const result = await summarizeForContext({
      body: "x",
      schema: baseSchema,
      source_url: "https://example.com",
      llm: mockLlm([badJson]),
    });
    expect(result.ok).toBe(true);
    expect(result.extracted!.fields.stars).toBeNull();
  });
});

describe("tryParseExtraction unit tests", () => {
  test("rejects non-object input", () => {
    expect(tryParseExtraction("null", ["a"])).toBeNull();
    expect(tryParseExtraction('"a string"', ["a"])).toBeNull();
    expect(tryParseExtraction("[1,2,3]", ["a"])).toBeNull();
  });

  test("rejects object with no `fields` key", () => {
    expect(tryParseExtraction('{"notes": "hi"}', ["a"])).toBeNull();
  });

  test("preserves boolean values as boolean", () => {
    const parsed = tryParseExtraction(
      '{"fields": {"is_active": {"value": true, "excerpt": "Active: yes"}}}',
      ["is_active"],
    );
    expect(parsed!.fields.is_active).toEqual({ value: true, excerpt: "Active: yes" });
  });

  test("truncates over-long excerpts to 400 chars", () => {
    const longExcerpt = "a".repeat(1000);
    const parsed = tryParseExtraction(
      JSON.stringify({ fields: { name: { value: "x", excerpt: longExcerpt } } }),
      ["name"],
    );
    expect(parsed!.fields.name!.excerpt.length).toBe(400);
  });
});
