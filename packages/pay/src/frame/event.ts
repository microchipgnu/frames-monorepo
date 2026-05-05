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
import type { Receipt, ToolInvokedEvent } from "../types.ts";

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
 */
export async function appendToolInvokedEvent(
  datasetPath: string,
  receipt: Receipt,
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
    payload: { receipt },
  };
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");
}
