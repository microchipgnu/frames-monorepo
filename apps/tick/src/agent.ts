// RunSession — the per-call Durable Object that runs the agent loop.
//
// Week 1 scaffold: placeholder so the workspace type-checks. The real class
// extends the Cloudflare `agents` SDK Agent base in week 2 and includes:
//
//   - SQLite state: runId, op, frame_url, budget, history, tool_log, settlement_handle
//   - Tool-use loop with verify-in-loop semantics
//   - frame MCP client (--transport http) for dataset I/O via bulk write tools
//     (set_facts, add_entity_with_facts, deprecate_fact, attach_evidence, query)
//   - catalog MCP tools: catalog.search / catalog.get / tool.invoke
//   - pay.Wallet for outbound payments (wraps Faremeter)
//   - Sub-agent routing via @cloudflare/think facets:
//       title  → Haiku 4.5
//       build  → Sonnet 4.6
//       explore → Sonnet 4.6 (or Haiku for cost)
//   - Budget enforcement (DO-local decrement + AI Gateway Custom Costs reconciliation)
//   - events.ndjson emission with run_id (frame v0.0.2 hook)

import type { Op, RunInput } from "@frames-ag/tick-types";

export interface RunSessionState {
  runId: string;
  op: Op;
  frame: string;
  budget: string;
  spent: string;
  startedAt: string;
  endedAt?: string;
}

export class RunSession {
  // Week 2: extend `Agent` from the `agents` package.
  // For now, just a typed placeholder so other modules can import the shape.

  constructor(public readonly state: RunSessionState) {}

  static fromRunInput(input: RunInput, runId: string): RunSessionState {
    return {
      runId,
      op: input.op,
      frame: input.frame,
      budget: input.budget,
      spent: "0",
      startedAt: new Date().toISOString(),
    };
  }
}
