// FilesystemStore — append-only NDJSON receipt log on disk.
//
// Used as:
//   - The fallback canonical log for explicit-call mode (no frame dataset
//     detected). Path: ~/.frames/pay/events.ndjson.
//   - A test seam: callers can construct one with a custom path.
//
// Per SPEC §"Audit projections", the *canonical* record of a paid call when
// frame integration is active is the dataset's `events.ndjson` — not this
// file. This file is the fallback for paid calls that happen outside any
// frame context. A future audit.ndjson projection (per-machine cache for
// fast browsing across all datasets) is out of scope for v0.0.8.

import { mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Receipt, ToolInvokedEvent } from "../types.ts";

export interface ReceiptStore {
  /** Append a single tool.invoked event built from the receipt. */
  append(receipt: Receipt): Promise<void>;
}

export class FilesystemStore implements ReceiptStore {
  constructor(public readonly path: string) {}

  async append(receipt: Receipt): Promise<void> {
    const event: ToolInvokedEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: "tool.invoked",
      agent: receipt.agent,
      payload: { receipt },
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  }
}

/** ~/.frames/pay/events.ndjson — fallback when no frame dataset detected. */
export function defaultFallbackPath(): string {
  const home = process.env["HOME"] ?? homedir();
  return resolve(home, ".frames", "pay", "events.ndjson");
}
