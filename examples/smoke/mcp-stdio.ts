#!/usr/bin/env bun
// Stage 2 smoke: spawn the pay-mcp server as a subprocess, drive it via the
// MCP SDK's stdio Client, exercise every tool, verify a real paid call works.
//
// Requires:
//   - examples/smoke/.wallet exists (run smoke:gen-wallet, fund it)
//   - PAY_BASE_SEPOLIA_KEY env var set to the .wallet's hex (we set it from the file)

import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { tmpdir, homedir } from "node:os";

void spawn; // referenced by transport

const WALLET_PATH = pathResolve(import.meta.dir, ".wallet");
if (!existsSync(WALLET_PATH)) {
  console.error("Run `bun smoke:gen-wallet` and fund the wallet first.");
  process.exit(1);
}
const privateKey = readFileSync(WALLET_PATH, "utf8").trim();

// Set up a throwaway config in a temp HOME so we don't clobber real ~/.frames/pay/config.yaml
const fakeHome = mkdtempSync(join(tmpdir(), "pay-mcp-home-"));
const cwd = mkdtempSync(join(tmpdir(), "pay-mcp-cwd-"));
let exitCode = 0;
try {
  const configDir = join(fakeHome, ".frames", "pay");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    `agent: claude:opus-4.7
catalog:
  default: https://catalog.microchipgnu.workers.dev
manifest_path: ./tools.yml
lock_path: ./tools.lock
wallets:
  base-sepolia:
    kind: evm
    label: smoke
    private_key: "${privateKey}"
    chain:
      id: 84532
      name: Base Sepolia
`,
  );

  console.log(`config:  ${join(configDir, "config.yaml")}`);
  console.log(`cwd:     ${cwd}`);
  console.log(`audit:   ${join(configDir, "audit-key.json")} (will be generated)`);

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", pathResolve(import.meta.dir, "../../src/mcp/bin.ts")],
    env: { ...process.env, HOME: fakeHome },
    cwd,
    stderr: "inherit",
  });
  const client = new Client(
    { name: "pay-smoke", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);

  // 1. List tools
  console.log("\n→ listTools");
  const tools = await client.listTools();
  console.log(`  ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);
  if (tools.tools.length !== 5) {
    console.log("✗ expected 5 tools");
    exitCode = 1;
  }

  // 2. wallet_status
  console.log("\n→ wallet_status");
  const status = await client.callTool({ name: "wallet_status", arguments: {} });
  console.log(textOf(status).split("\n").map((l) => `  ${l}`).join("\n"));

  // 3. discover with q
  console.log("\n→ discover { q: 'echo', limit: 3 }");
  const discover = await client.callTool({
    name: "discover",
    arguments: { q: "echo", limit: 3 },
  });
  console.log(textOf(discover).split("\n").slice(0, 8).map((l) => `  ${l}`).join("\n"));

  // 4. add_tool
  console.log("\n→ add_tool { url: catalog/tools/frames.test.post.api-echo, as: test }");
  const added = await client.callTool({
    name: "add_tool",
    arguments: {
      url: "https://catalog.microchipgnu.workers.dev/tools/frames.test.post.api-echo",
      as: "test",
    },
  });
  console.log(textOf(added).split("\n").map((l) => `  ${l}`).join("\n"));

  // 5. list_tools
  console.log("\n→ list_tools");
  const list = await client.callTool({ name: "list_tools", arguments: {} });
  console.log(textOf(list).split("\n").map((l) => `  ${l}`).join("\n"));

  // 6. pay_tool — the real test
  console.log("\n→ pay_tool { name: 'test', params: {...} }");
  const paid = await client.callTool({
    name: "pay_tool",
    arguments: { name: "test", params: { data: { from: "mcp-stdio-smoke" } } },
  });
  if ((paid as { isError?: boolean }).isError) {
    console.log("  ✗ pay_tool returned an error:");
    console.log(textOf(paid).split("\n").map((l) => `    ${l}`).join("\n"));
    exitCode = 1;
  } else {
    const parsed = JSON.parse(textOf(paid)) as {
      body: unknown;
      receipt: { tx_hash?: string; descriptor_id: string; amount: string; currency: string };
    };
    console.log(`  ✓ amount: ${parsed.receipt.amount} ${parsed.receipt.currency}`);
    console.log(`  ✓ descriptor_id: ${parsed.receipt.descriptor_id.slice(0, 28)}…`);
    console.log(`  ✓ tx_hash: ${parsed.receipt.tx_hash}`);
    if (!parsed.receipt.tx_hash || !parsed.receipt.tx_hash.startsWith("0x")) {
      console.log("  ✗ tx_hash missing or malformed");
      exitCode = 1;
    }
  }

  await client.close();

  console.log();
  if (exitCode === 0) {
    console.log("✓ Stage 2 MCP server works end-to-end over stdio");
  } else {
    console.log("✗ Stage 2 smoke had failures");
  }
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(exitCode);

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}
