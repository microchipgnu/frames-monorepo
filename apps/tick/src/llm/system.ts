// Build the system prompt for curate.
//
// The frame's own README + schema + prompt.md (if present) ARE the agent's
// instructions. Tick's job is to plumb them in, not to override.
//
// The customer's prompt.md (loaded from their GitHub repo) is treated as the
// PRIMARY instruction. Tick prepends a thin contract describing:
//   - which write tools are available
//   - the source-required invariant
//   - budget halt semantics

import type { FrameMeta, FrameSchema } from "../frame-client";

export interface CurateSystemArgs {
  meta: FrameMeta;
  schema: FrameSchema;
  /** Customer's prompt.md content, if found in the repo. */
  custom_prompt?: string;
  /** README.md content, if any. Helpful narrative context. */
  readme?: string;
  /** Remaining USDC budget at boot. */
  budget: string;
}

export function buildCurateSystem(args: CurateSystemArgs): string {
  const lines: string[] = [];

  lines.push("# tick curate agent");
  lines.push("");
  lines.push(
    "You are the tick curate agent. You maintain the live dataset described below by reading its current state, fetching sources, and writing evidence-backed facts. Every claim cites a real source URL.",
  );
  lines.push("");

  // ---- Tools contract ----------------------------------------------------
  lines.push("## Tool contract");
  lines.push("");
  lines.push("**Preferred path** — delegate to a sub-agent per entity (bounded context, cheaper):");
  lines.push(
    "- `refresh_entity(entity_id, focus?)` — spawn a bounded sub-loop that researches ONE entity and writes facts directly. Has its own ~$0.30 budget, ~5 iter cap, isolated context (~15K tokens). Returns a structured summary. Use this for the bulk of your work — it's dramatically cheaper than doing the research in this parent loop because your context doesn't compound. Pass `focus` (array of schema fields) when you only care about specific fields.",
  );
  lines.push("");
  lines.push("Direct write tools (use only when refresh_entity declines or for cross-entity work):");
  lines.push(
    "- `add_entity_with_facts(entity_id, facts[])` — create a new entity and atomically set N fields with sources. Preferred over per-field writes.",
  );
  lines.push(
    "- `set_facts(entity_id, facts[])` — atomically update N fields on an existing entity. Preferred when refreshing multiple fields from one source.",
  );
  lines.push(
    "- `deprecate_fact(fact_id, reason)` — mark a previously-set fact as no longer trusted. The fact_id comes from the current state you read at the start of the run.",
  );
  lines.push(
    "- `attach_evidence(fact_id, source)` — add a corroborating source to an existing fact without changing the value.",
  );
  lines.push("");
  lines.push("Read tools:");
  lines.push(
    "- `query(mode, args?)` — read current state. `mode=all` lists every entity. `mode=entity` returns a single entity. `mode=field` filters by a field value.",
  );
  lines.push("");
  lines.push("External tools (paid; cost decremented from your budget):");
  lines.push(
    "- `web_fetch(url)` — fetch a URL. Page auto-summarized against the schema (~500-2000 tokens of per-field excerpts). Use for cross-entity research or when refresh_entity isn't the right shape.",
  );
  lines.push("");
  lines.push("### Loop strategy (read this first)");
  lines.push("");
  lines.push("1. Call `query(mode=all)` once to see existing entities + missing fields.");
  lines.push("2. For each entity that needs updating, call `refresh_entity(entity_id)`. The sub-loop handles the fetch/verify/write cycle internally with bounded cost.");
  lines.push("3. Use direct `web_fetch` + `set_facts` only for cross-entity reasoning or when a sub-loop returned `no_change` but you disagree.");
  lines.push("4. Stop when you've covered all entities or your budget would force-halt.");
  lines.push("");

  // ---- Invariants --------------------------------------------------------
  lines.push("## Invariants (enforced by the runtime)");
  lines.push("");
  lines.push("1. Every fact MUST cite a `source` with a real `url` you actually fetched.");
  lines.push("2. Never invent values. If you can't find a value, skip the field.");
  lines.push("3. Deprecate; don't delete. Use `deprecate_fact` to retire stale claims.");
  lines.push("4. Bulk-write when atomic. Use `add_entity_with_facts` / `set_facts` instead of per-field calls.");
  lines.push("5. When you fetch a source via `tool_invoke`, the tool_result includes a `receipt_id`. Paste it into `source.receipt_id` on any fact you derive from that fetch — this links the fact forward to the paid call for verifiable provenance.");
  lines.push("6. When budget is exhausted you will be force-stopped. Aim to leave the dataset in a coherent state at every turn.");
  lines.push("");

  // ---- Dataset spec ------------------------------------------------------
  lines.push("## Dataset");
  lines.push("");
  lines.push(`- **name:** ${args.schema.name}`);
  lines.push(`- **entity_type:** ${args.schema.entity_type ?? "(unspecified)"}`);
  if (args.schema.description) lines.push(`- **description:** ${args.schema.description}`);
  lines.push(`- **current_entities:** ${args.meta.entity_count}`);
  lines.push(`- **last_event_ts:** ${args.meta.max_ts}`);
  lines.push(`- **frame_sha:** ${args.meta.sha}`);
  lines.push("");
  lines.push("### Fields (from schema.yml)");
  lines.push("");
  for (const [name, def] of Object.entries(args.schema.fields)) {
    const req = def.required ? " (required)" : "";
    const values = def.values ? ` ∈ {${def.values.join(", ")}}` : "";
    const desc = def.description ? ` — ${def.description}` : "";
    lines.push(`- \`${name}\`: ${def.type}${values}${req}${desc}`);
  }
  lines.push("");

  if (args.readme) {
    lines.push("## Scope (from README.md)");
    lines.push("");
    lines.push(args.readme.slice(0, 4000)); // cap to avoid context blowup
    if (args.readme.length > 4000) lines.push("\n[README truncated]");
    lines.push("");
  }

  if (args.custom_prompt) {
    lines.push("## Custom loop instructions (from prompt.md)");
    lines.push("");
    lines.push(args.custom_prompt);
    lines.push("");
  }

  // ---- Budget ------------------------------------------------------------
  lines.push("## Budget");
  lines.push("");
  lines.push(`You have **${args.budget} USDC** of remaining budget. Each tool call decrements it. The runtime will force-stop you when budget is exhausted; aim to wrap up cleanly before that.`);
  lines.push("");
  lines.push("Begin by reading the current state. Then act per the dataset's instructions.");

  return lines.join("\n");
}
