// One-off backfill: stamp `accepts_networks` onto every slim entry in
// content/index.ndjson and content/index-longtail.ndjson by joining against
// the full descriptors in content/tools/<id>.json.
//
// Lifecycle: needed once after the projection schema gained accepts_networks
// (PR feat/catalog-multi-rail). The next regular `bun run project` run
// (post merge.ts) will produce the same data path-of-record. After that
// happens at least once, this script can be deleted.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDescriptor } from "../server/src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CONTENT = resolve(ROOT, "content");

function deriveAcceptsNetworks(payment: ToolDescriptor["payment"]): string | undefined {
  const networks = new Set<string>();
  if (payment.network) networks.add(payment.network);
  if (Array.isArray(payment.accepts)) {
    for (const opt of payment.accepts) {
      if (opt && typeof opt === "object" && typeof opt.network === "string") {
        networks.add(opt.network);
      }
    }
  }
  if (networks.size <= 1) return undefined;
  return Array.from(networks).join(",");
}

function processIndex(path: string): { entries: number; stamped: number } {
  if (!existsSync(path)) {
    console.error(`skipping (missing): ${path}`);
    return { entries: 0, stamped: 0 };
  }
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  let stamped = 0;
  const out: string[] = [];
  for (const line of lines) {
    const slim = JSON.parse(line) as ToolDescriptor;
    const toolPath = resolve(CONTENT, "tools", `${slim.id}.json`);
    if (!existsSync(toolPath)) {
      out.push(JSON.stringify(slim));
      continue;
    }
    const full = JSON.parse(readFileSync(toolPath, "utf-8")) as ToolDescriptor;
    const accepts = deriveAcceptsNetworks(full.payment);
    if (accepts !== undefined) {
      // Reconstruct with a canonical key order so the diff stays clean.
      const updated: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(slim)) {
        if (k === "_meta") continue;
        updated[k] = v;
      }
      updated.accepts_networks = accepts;
      if (slim._meta) updated._meta = slim._meta;
      out.push(JSON.stringify(updated));
      stamped++;
    } else {
      out.push(JSON.stringify(slim));
    }
  }
  writeFileSync(path, out.join("\n") + "\n");
  return { entries: lines.length, stamped };
}

const main = () => {
  const a = processIndex(resolve(CONTENT, "index.ndjson"));
  console.log(`index.ndjson:           ${a.entries} entries, ${a.stamped} stamped with accepts_networks`);
  const b = processIndex(resolve(CONTENT, "index-longtail.ndjson"));
  console.log(`index-longtail.ndjson:  ${b.entries} entries, ${b.stamped} stamped with accepts_networks`);
};

main();
