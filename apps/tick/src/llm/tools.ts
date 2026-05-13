// Tool specs exposed to the curate agent.
//
// Mirrors frame's MCP write tools (set_facts, add_entity_with_facts,
// deprecate_fact, attach_evidence) + a single read tool (query) + a paid
// external fetch tool (web_fetch). Future: replace web_fetch with full
// catalog discovery (catalog.search, catalog.get, tool.invoke).

import type { LlmToolSpec } from "./client";

const sourceSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "Source URL you actually fetched" },
    retrieved_at: { type: "string", description: "ISO 8601 timestamp of the fetch" },
    title: { type: "string" },
    archive_url: { type: "string" },
    excerpt: { type: "string", description: "Verbatim quote supporting the claim" },
    receipt_id: {
      type: "string",
      description:
        "If this source URL came from a `tool_invoke` call, paste the receipt_id from the tool_result here. Links the fact forward to the paid call that produced the URL — required for full provenance.",
    },
  },
  required: ["url", "retrieved_at"],
};

export const CURATE_TOOLS: LlmToolSpec[] = [
  {
    name: "query",
    description:
      "Read current frame state. `mode=all` returns all entities. `mode=entity` returns one entity by id. `mode=field` returns entities whose field equals value.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "entity", "field"] },
        entity_id: { type: "string", description: "required when mode=entity" },
        field: { type: "string", description: "required when mode=field" },
        value: { description: "optional value to match when mode=field" },
      },
      required: ["mode"],
    },
  },
  {
    name: "add_entity_with_facts",
    description:
      "Atomically create a new entity and set multiple facts on it. Emits a single facts.set_many frame event. Each fact must cite a source.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "Slug-shaped id (e.g. 'acme-fi'). Must be unique.",
        },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field name from schema.yml" },
              value: { description: "Typed value (string/int/bool/etc per schema)" },
              source: sourceSchema,
              confidence: { type: "number", description: "0..1, optional" },
              observed_at: { type: "string", description: "ISO 8601, optional" },
            },
            required: ["field", "value", "source"],
          },
        },
      },
      required: ["entity_id", "facts"],
    },
  },
  {
    name: "set_facts",
    description:
      "Atomically update multiple facts on an existing entity. Emits a single facts.set_many frame event. Last-write-wins for (entity, field).",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: {},
              source: sourceSchema,
              confidence: { type: "number" },
              observed_at: { type: "string" },
            },
            required: ["field", "value", "source"],
          },
        },
      },
      required: ["entity_id", "facts"],
    },
  },
  {
    name: "deprecate_fact",
    description:
      "Mark a previously-set fact as no longer trusted. Use the fact_id surfaced by query results.",
    input_schema: {
      type: "object",
      properties: {
        fact_id: { type: "string" },
        reason: { type: "string", description: "Required, human-readable" },
      },
      required: ["fact_id", "reason"],
    },
  },
  {
    name: "attach_evidence",
    description:
      "Add a corroborating source to an existing fact without changing its value.",
    input_schema: {
      type: "object",
      properties: {
        fact_id: { type: "string" },
        source: sourceSchema,
      },
      required: ["fact_id", "source"],
    },
  },
  {
    name: "catalog_search",
    description:
      "Search the federated tool catalog at catalog.frames.ag for paid tools matching a capability. Returns up to N ToolDescriptors with id, title, capabilities, payment.price_hint. Use this BEFORE web_fetch when you need a kind of tool (e.g. capability='web-search', 'scrape', 'enrich') — the catalog routes you to the cheapest/best provider.",
    input_schema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description:
            "Capability tag, e.g. 'web-search', 'scrape', 'enrich', 'image-gen', 'transcribe'.",
        },
        limit: { type: "number", description: "Max results (1–50). Default 10." },
      },
    },
  },
  {
    name: "catalog_get",
    description:
      "Resolve a single ToolDescriptor by id. Use after catalog_search if you need the full schemas before calling tool_invoke.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "tool_invoke",
    description:
      "Invoke a catalog tool by descriptor id. The runtime resolves the descriptor, builds the request per its invocation spec, and calls via paidFetch (which auto-handles x402/MPP 402 challenges). Returns the response body + the settled cost. Preferred over web_fetch when a matching descriptor exists.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ToolDescriptor id from the catalog" },
        args: {
          type: "object",
          description: "Arguments matching descriptor.invocation.params_schema",
          additionalProperties: true,
        },
      },
      required: ["id"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Direct fetch of a URL via paidFetch. Use as a fallback when the catalog doesn't have a matching descriptor, or when you need to fetch a specific URL the catalog doesn't index (raw GitHub README, vendor docs page, etc.). The page is auto-summarized by a cheap LLM against the dataset schema before you see it — you get ~500-2000 tokens of structured per-field excerpts, not raw HTML. Pass `entity_hint` when you know which existing entity (or candidate) the page is about — it focuses the summarizer.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        entity_hint: {
          type: "string",
          description: "Optional. Entity id or name the page is about; helps the summarizer focus.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "refresh_entity",
    description:
      "Spawn a bounded sub-agent that researches ONE existing entity and writes facts directly. Sub-agent has its own context (~15K tokens), budget (~$0.30), and 5-iter cap; runs in parallel with other sub-agents in its own Durable Object isolate. Use this for REFRESH-mode work — updating / verifying / deprecating facts on entities that are already in the dataset. Pass `focus` (schema fields) to narrow scope.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "entity to refresh; must already exist in the dataset" },
        focus: {
          type: "array",
          items: { type: "string" },
          description: "Optional: schema fields to prioritize. Empty means 'check everything'.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "discover_entity",
    description:
      "Spawn a bounded sub-agent that investigates ONE candidate NEW entity. Sub-agent verifies the candidate against sources and either (a) proposes the entity with researched facts — the runtime emits the `entity.created` + `facts.set_many` events for you, no follow-up tool call needed, (b) reports it already exists in the dataset under a known entity_id, or (c) rejects it as unverifiable / out-of-scope. Use this for EXPAND-mode work — adding entities the dataset is missing. Pass `seed_urls` when you already know where to start looking; pass `fields_to_find` to focus the sub-agent on specific schema fields. Same context/budget/parallelism profile as refresh_entity.",
    input_schema: {
      type: "object",
      properties: {
        hypothesis: {
          type: "string",
          description:
            "Natural-language description of the candidate entity — e.g. 'A biotech company called Genomique, founded 2024 in Paris, focused on cancer diagnostics'. The more specific, the cheaper the sub-loop runs.",
        },
        seed_urls: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: URLs you've already identified as relevant. The sub-loop fetches these first, saving an exploration iter.",
        },
        fields_to_find: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: schema fields to gather if the entity turns out to be real. Empty means 'gather everything the sources support'.",
        },
      },
      required: ["hypothesis"],
    },
  },
];
