#!/usr/bin/env bun
// pay-mcp executable. Stdio MCP server.
// `bunx -y @frames-ag/pay-mcp` will resolve here once published.
import { startServer } from "./server.ts";

startServer().catch((e) => {
  console.error(`[pay-mcp] fatal: ${(e as Error).message}`);
  process.exit(1);
});
