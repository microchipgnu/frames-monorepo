// pay MCP server (stdio).
//
// Exposes pay's library as 5 MCP tools:
//   pay_tool, add_tool, list_tools, discover, wallet_status
//
// Run: `bunx -y @frames-ag/pay-mcp` (when published) or `bun run src/mcp/server.ts`.
// Reads ~/.frames/pay/config.yaml; creates audit key on first use.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadRuntimeConfig } from "../config.ts";
import { payToolHandler, payToolSchema } from "./tools/pay-tool.ts";
import { addToolHandler, addToolSchema } from "./tools/add-tool.ts";
import { listToolsHandler, listToolsSchema } from "./tools/list-tools.ts";
import { discoverHandler, discoverSchema } from "./tools/discover.ts";
import {
  walletStatusHandler,
  walletStatusSchema,
} from "./tools/wallet-status.ts";

export async function startServer(): Promise<void> {
  const config = await loadRuntimeConfig();

  const server = new Server(
    { name: "pay", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  const tools = [
    payToolSchema,
    addToolSchema,
    listToolsSchema,
    discoverSchema,
    walletStatusSchema,
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
        case "pay_tool":
          return await payToolHandler(args ?? {}, config);
        case "add_tool":
          return await addToolHandler(args ?? {}, config);
        case "list_tools":
          return await listToolsHandler(args ?? {}, config);
        case "discover":
          return await discoverHandler(args ?? {}, config);
        case "wallet_status":
          return await walletStatusHandler(args ?? {}, config);
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      return {
        isError: true,
        content: [{ type: "text" as const, text: `pay error: ${msg}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
