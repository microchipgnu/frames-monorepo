// MCP server export for tick. Exposes the four ops (curate/refresh/verify/
// discover) as MCP tools that any MCP-aware harness (opencode, Claude Code,
// Codex CLI, Cursor) can call. The server itself is a thin proxy: it accepts
// tool calls, makes HTTP requests to the hosted runtime at TICK_API_URL,
// and returns the response. The actual agent loop runs on our infra.
//
// Per PLAN.md §3c — the runtime is callable from any external harness.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BUDGETS } from "@frames-ag/tick-types";

const TICK_API_URL = process.env.TICK_API_URL ?? "https://tick.frames.ag";
const TICK_API_KEY = process.env.TICK_API_KEY;

// Common input schema across all four ops. Each tool refines `description`
// and the default budget, but the shape is uniform — frame URL + budget +
// op-specific params.
const sharedInputSchema = {
  type: "object",
  properties: {
    frame: {
      type: "string",
      description: "Frame URL: https://github.com/<user>/<repo>[/<frame_path>]",
    },
    budget: {
      type: "string",
      description: "Upper-bound USDC budget (upto-settled). Defaults vary per op.",
    },
    params: {
      type: "object",
      description: "Op-specific parameters (passed through to the runtime).",
      additionalProperties: true,
    },
  },
  required: ["frame"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "runtime.verify",
    description:
      "Read-only re-fetch of every fact's source URL. Reports drift (source_dead / value_drift / excerpt_missing / source_redirect). Does NOT mutate the frame. Returns the run_id, settled cost, and a structured drift report.",
    default_budget: DEFAULT_BUDGETS.verify,
  },
  {
    name: "runtime.refresh",
    description:
      "Same iteration as verify, but converts findings into actual frame events: fact.deprecated for dead/drifted sources, evidence.attached for redirects. Returns the events to apply to the frame's events.ndjson plus the drift report.",
    default_budget: DEFAULT_BUDGETS.refresh,
  },
  {
    name: "runtime.curate",
    description:
      "Full agent loop: read state, search sources via the federated catalog at catalog.frames.ag, write new facts with evidence (entity.created, fact.set, facts.set_many). The most powerful op; uses the most budget.",
    default_budget: DEFAULT_BUDGETS.curate,
  },
  {
    name: "runtime.discover",
    description:
      "Search-only: propose candidate entities matching the frame's scope, with evidence. Writes go to report.candidates[] (review queue), not directly to the frame.",
    default_budget: DEFAULT_BUDGETS.discover,
  },
] as const;

// Manual sync with package.json `version`. Bump both together when releasing.
// (Dynamic read at runtime would couple the bundle to package.json layout
// which Bun's bundler doesn't ship by default.)
const TICK_VERSION = "0.3.5";

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "tick", version: TICK_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: `${t.description}\n\nDefault budget: ${t.default_budget} USDC. Backend: ${TICK_API_URL}.`,
      inputSchema: sharedInputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    const a = (args ?? {}) as { frame?: string; budget?: string; params?: unknown };
    if (!a.frame) {
      return {
        isError: true,
        content: [{ type: "text", text: `Missing required parameter: frame` }],
      };
    }

    const op = name.replace(/^runtime\./, "");
    const payload = {
      op,
      frame: a.frame,
      budget: a.budget ?? tool.default_budget,
      ...(a.params ? { params: a.params } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${TICK_API_URL}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(TICK_API_KEY ? { authorization: `Bearer ${TICK_API_KEY}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Network error calling ${TICK_API_URL}/run: ${(e as Error).message}`,
          },
        ],
      };
    }

    const bodyText = await response.text();
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Runtime ${response.status}: ${bodyText}` }],
      };
    }
    return {
      content: [{ type: "text", text: bodyText }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdio transport keeps the process alive until stdin closes.
}
