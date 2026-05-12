#!/usr/bin/env bun
//
// tick CLI — dispatches to subcommands.
//
//   tick mcp                   # start the MCP server over stdio (for opencode/Claude Code wiring)
//   tick verify <frame>        # run the verify op locally against the hosted runtime
//   tick refresh <frame>       # run the refresh op
//   tick curate <frame>        # full agent loop with optional customer prompt
//   tick discover <frame>      # search-only candidate proposer
//
// Prompt discovery (curate / discover): the CLI auto-finds `prompt.md` next
// to the dataset path relative to the current working directory. So when
// invoked as `tick curate https://github.com/<user>/<repo>/datasets/foo`, the
// CLI checks `./datasets/foo/prompt.md` and POSTs its contents as
// `params.customer_prompt`. Override with `--prompt-file <path>`.
//
// In a harness's .mcp.json the canonical entry is:
//
//   {
//     "mcpServers": {
//       "frames-runtime": {
//         "command": "npx",
//         "args": ["-y", "@frames-ag/tick", "mcp"],
//         "env": { "TICK_API_URL": "https://tick.frames.ag", "TICK_API_KEY": "..." }
//       }
//     }
//   }

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startMcpServer } from "./mcp";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "mcp":
    await startMcpServer();
    break;
  case "verify":
  case "refresh":
  case "curate":
  case "discover":
    await runOp(command, rest);
    break;
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    process.exit(0);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

function printUsage(): void {
  console.error(`
tick — hosted runtime for frame datasets

Usage:
  tick mcp                                 Start the MCP server (stdio)
  tick verify <frame-url> [--budget 0.15]  Run verify against tick.frames.ag
  tick refresh <frame-url> [--budget 0.30]
  tick curate <frame-url> [--budget 1.50] [--prompt-file <path>]
  tick discover <frame-url> [--budget 0.50] [--prompt-file <path>]

Prompt discovery (curate/discover):
  Auto-finds <path-from-frame-url>/prompt.md relative to the current
  directory. Override with --prompt-file <path>. Pass --no-prompt to
  skip the file even when present.

Env:
  TICK_API_URL          Hosted runtime base URL. Default: https://tick.frames.ag
  TICK_API_KEY          Bearer token for the hosted endpoint.
  FRAMES_CLOUD_BASE     Override frames-cloud resolver. Default: https://frames-cloud.workers.dev
`.trim());
}

/**
 * Try to find a customer prompt file. Priority:
 *   1. `--prompt-file <path>` flag (explicit) — error if it doesn't exist
 *   2. `--no-prompt` flag — skip discovery
 *   3. Auto-discover from the frame URL path: extract the path component
 *      after `github.com/<user>/<repo>/` and look for `<that>/prompt.md`
 *      relative to cwd.
 *   4. Fall back to `./prompt.md` if the frame URL has no sub-path.
 *
 * Returns null when no prompt should be sent. Prints what it did to stderr
 * so the CI log shows whether a prompt was picked up.
 */
function resolveCustomerPrompt(frame: string, rest: string[]): string | null {
  if (rest.includes("--no-prompt")) {
    console.error(`[tick] --no-prompt set, skipping prompt discovery`);
    return null;
  }
  const explicitIdx = rest.indexOf("--prompt-file");
  if (explicitIdx >= 0) {
    const path = rest[explicitIdx + 1];
    if (!path) {
      console.error(`Error: --prompt-file requires a path argument`);
      process.exit(1);
    }
    const abs = resolve(process.cwd(), path);
    if (!existsSync(abs)) {
      console.error(`Error: --prompt-file ${abs} does not exist`);
      process.exit(1);
    }
    const content = readFileSync(abs, "utf-8");
    console.error(`[tick] prompt: ${abs} (${content.length} bytes, explicit)`);
    return content;
  }

  // Auto-discover from frame URL. Example:
  //   frame = https://github.com/microchipgnu/frames-examples/datasets/mcp-servers
  //   → path component = datasets/mcp-servers
  //   → candidate = ./datasets/mcp-servers/prompt.md
  let candidate: string | null = null;
  const match = frame.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/?(.*)$/);
  if (match && match[1]) {
    candidate = resolve(process.cwd(), match[1], "prompt.md");
  } else {
    // Frame URL has no sub-path (whole-repo frame). Look in cwd.
    candidate = resolve(process.cwd(), "prompt.md");
  }
  if (candidate && existsSync(candidate)) {
    const content = readFileSync(candidate, "utf-8");
    console.error(`[tick] prompt: ${candidate} (${content.length} bytes, auto-discovered)`);
    return content;
  }
  console.error(`[tick] no prompt.md found at ${candidate}; proceeding without customer prompt`);
  return null;
}

async function runOp(op: "verify" | "refresh" | "curate" | "discover", rest: string[]): Promise<void> {
  // Walk rest skipping --flag value pairs so we get the positional frame URL.
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--budget" || arg === "--prompt-file") {
      i++; // skip the value
      continue;
    }
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  const frame = positional[0];
  if (!frame) {
    console.error(`Error: <frame-url> argument required`);
    printUsage();
    process.exit(1);
  }

  const budgetIdx = rest.indexOf("--budget");
  const budget = budgetIdx >= 0 ? rest[budgetIdx + 1] : undefined;
  const base = process.env.TICK_API_URL ?? "https://tick.frames.ag";
  const key = process.env.TICK_API_KEY;

  // Auto-discover a customer prompt for curate / discover. verify and refresh
  // don't use one (they're deterministic re-fetch loops).
  const customerPrompt =
    op === "curate" || op === "discover" ? resolveCustomerPrompt(frame, rest) : null;

  const body: Record<string, unknown> = { op, frame };
  if (budget) body.budget = budget;
  if (customerPrompt) body.params = { customer_prompt: customerPrompt };

  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  process.stdout.write(text + "\n");
  process.exit(res.ok ? 0 : 1);
}
