// Frame integration — write tool.invoked events into a frame dataset's
// events.ndjson when pay is invoked from a frame context.
//
// Per pay/SPEC.md §"Frame integration":
//   "The full receipt is inlined in the event payload — the dataset's
//   events.ndjson is the canonical record of payments, not any
//   per-machine file."
//
// Detection precedence:
//   1. PAY_FRAME_DATASET env var — explicit absolute or cwd-relative path
//      to a frame dataset directory.
//   2. cwd heuristic — if process.cwd() contains BOTH schema.yml and
//      events.ndjson, treat cwd itself as the dataset.
//   3. None — caller falls back to ~/.frames/pay/events.ndjson via
//      FilesystemStore.

import { existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Receipt,
  ToolInvokedEvent,
  ToolInvocationPayload,
} from "../types.ts";

/** Default response excerpt cap, in bytes. Override via PAY_TOOL_BODY_MAX_BYTES. */
const DEFAULT_RESPONSE_CAP = 2048;

/**
 * Build the optional tool payload for a tool.invoked event.
 *
 * - Params are stored verbatim by default. Set `PAY_REDACT_PARAMS=true` to
 *   substitute with a placeholder string (still verifiable via the receipt's
 *   `params_hash`).
 * - Response is excerpted to PAY_TOOL_BODY_MAX_BYTES (default 2048).
 *
 * Returns undefined if PAY_INLINE_TOOL_DATA=false (full opt-out).
 */
export function buildToolPayload(
  params: unknown,
  responseText: string,
): ToolInvocationPayload | undefined {
  if (process.env["PAY_INLINE_TOOL_DATA"] === "false") return undefined;

  const redact = process.env["PAY_REDACT_PARAMS"] === "true";
  const capRaw = parseInt(
    process.env["PAY_TOOL_BODY_MAX_BYTES"] ?? `${DEFAULT_RESPONSE_CAP}`,
    10,
  );
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_RESPONSE_CAP;

  const sizeBytes = new TextEncoder().encode(responseText).byteLength;
  const truncated = sizeBytes > cap;
  const excerpt = truncated ? responseText.slice(0, cap) : responseText;

  return {
    params: redact ? "[redacted; hash in receipt]" : params,
    response_excerpt: excerpt,
    response_size_bytes: sizeBytes,
    response_truncated: truncated,
  };
}

/** Returns absolute path to detected frame dataset, or null. */
export function detectFrameDataset(cwd: string = process.cwd()): string | null {
  const explicit = process.env["PAY_FRAME_DATASET"];
  if (typeof explicit === "string" && explicit.length > 0) {
    return resolve(cwd, explicit);
  }
  const schema = resolve(cwd, "schema.yml");
  const events = resolve(cwd, "events.ndjson");
  if (existsSync(schema) && existsSync(events)) {
    return cwd;
  }
  return null;
}

/**
 * Append a tool.invoked event with the inlined receipt to the dataset's
 * events.ndjson. Only writes if the path actually exists — never creates
 * a new events.ndjson, since that would change semantics for the frame
 * engine.
 *
 * Optional `tool` arg surfaces the actual params + response excerpt
 * alongside the receipt's hashes.
 */
export async function appendToolInvokedEvent(
  datasetPath: string,
  receipt: Receipt,
  tool?: ToolInvocationPayload,
): Promise<void> {
  const eventsPath = resolve(datasetPath, "events.ndjson");
  if (!existsSync(eventsPath)) {
    throw new Error(
      `frame dataset at ${datasetPath} has no events.ndjson — refusing to create one`,
    );
  }
  const event: ToolInvokedEvent = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "tool.invoked",
    agent: receipt.agent,
    payload: { receipt, ...(tool !== undefined && { tool }) },
  };
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");
}
