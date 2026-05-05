#!/usr/bin/env bun
// pay-mcp executable. Stdio MCP server.
// `bunx -y @frames-ag/pay-mcp` resolves here.
//
// Optional CLI flags (set env vars consumed by config.ts):
//   --manifest <path>  → PAY_MANIFEST_PATH (per-dataset tools.yml)
//   --lock <path>      → PAY_LOCK_PATH
//   --dataset <path>   → PAY_FRAME_DATASET (sets manifest + receipt destination)
//
// All three may also be set via env directly. Flags win over env when both are
// passed for the same setting.

import { startServer } from "./server.ts";

function parseArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if ((a === "--manifest" || a === "-m") && typeof next === "string") {
      process.env["PAY_MANIFEST_PATH"] = next;
      i++;
    } else if (a === "--lock" && typeof next === "string") {
      process.env["PAY_LOCK_PATH"] = next;
      i++;
    } else if ((a === "--dataset" || a === "-d") && typeof next === "string") {
      process.env["PAY_FRAME_DATASET"] = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`pay-mcp — stdio MCP server for paid agent tool calls

Usage: pay-mcp [options]

Options:
  -m, --manifest <path>   path to tools.yml (env: PAY_MANIFEST_PATH)
  --lock <path>           path to tools.lock (env: PAY_LOCK_PATH)
  -d, --dataset <path>    frame dataset dir; sets manifest = <path>/tools.yml
                          and persists tool.invoked events to <path>/events.ndjson
                          (env: PAY_FRAME_DATASET)
  -h, --help              show this help

Defaults: manifest=./tools.yml, lock=./tools.lock (resolved against cwd).
`);
      process.exit(0);
    }
  }
}

parseArgs(process.argv.slice(2));

startServer().catch((e) => {
  console.error(`[pay-mcp] fatal: ${(e as Error).message}`);
  process.exit(1);
});
