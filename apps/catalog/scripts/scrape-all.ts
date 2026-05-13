#!/usr/bin/env bun
// Run all source scrapers in parallel (Promise.allSettled — one source
// failing never kills the rest). Then probe-discovery sequentially because
// it needs staging/bazaar-merchants.json.
//
// Emits staging/refresh-meta.json so the server can report per-source
// freshness ("Bazaar refreshed 2m ago, MPP cache 6h old, x402scan stale").
//
// Flags forwarded to children: --refresh (re-probe), --limit N (cap probe).

import { $ } from "bun";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";

type SourceResult = {
  name: string;
  status: "ok" | "fail";
  ms: number;
  err?: string;
  output_files?: string[];
  output_bytes?: number;
};

const parallelJobs = [
  { name: "bazaar", cmd: "bun scripts/scrape-bazaar.ts", outputs: ["staging/bazaar-items.json", "staging/bazaar-merchants.json"] },
  { name: "agentic-market", cmd: "bun scripts/scrape-agentic-market.ts", outputs: ["staging/agentic-market.json"] },
  { name: "paysh", cmd: "bun scripts/scrape-paysh.ts", outputs: ["staging/paysh.json"] },
  { name: "mpp-directory", cmd: "bun scripts/scrape-mpp-directory.ts", outputs: ["staging/mpp-directory-services.json", "staging/mpp-directory-merchants.json"] },
  { name: "mppscan", cmd: "bun scripts/scrape-mppscan.ts", outputs: ["staging/mppscan.json"] },
  { name: "x402scan", cmd: "bun scripts/scrape-x402scan.ts", outputs: ["staging/x402scan.json"] },
  { name: "frames-registry", cmd: "bun scripts/scrape-frames-registry.ts", outputs: ["staging/frames-registry-services.json", "staging/frames-registry-merchants.json"] },
] as const;

const sequentialJobs = [
  // probe-discovery has a 7-day cache so re-running every refresh is cheap;
  // only hosts that haven't been probed in 7d get hit.
  { name: "probe-discovery", cmd: "bun scripts/probe-discovery.ts", outputs: ["staging/probe-results.json"] },
] as const;

function summarizeFiles(paths: readonly string[]): { files: string[]; bytes: number } {
  const files: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    if (existsSync(p)) {
      files.push(p);
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

const started = Date.now();
const forwardArgs = process.argv.slice(2).join(" ");

async function runJob(job: { name: string; cmd: string; outputs: readonly string[] }): Promise<SourceResult> {
  const t = Date.now();
  try {
    const fullCmd = forwardArgs ? `${job.cmd} ${forwardArgs}` : job.cmd;
    await $`bash -c ${fullCmd}`.quiet();
    const { files, bytes } = summarizeFiles(job.outputs);
    return { name: job.name, status: "ok", ms: Date.now() - t, output_files: files, output_bytes: bytes };
  } catch (e: any) {
    const { files, bytes } = summarizeFiles(job.outputs);
    return {
      name: job.name,
      status: "fail",
      ms: Date.now() - t,
      err: String(e?.stderr ?? e).slice(0, 500),
      output_files: files,
      output_bytes: bytes,
    };
  }
}

const parallelResults = await Promise.allSettled(parallelJobs.map((j) => runJob(j as any)));
const flatResults: SourceResult[] = parallelResults.map((r) =>
  r.status === "fulfilled" ? r.value : { name: "?", status: "fail", ms: 0, err: String(r.reason) },
);

for (const j of sequentialJobs) {
  flatResults.push(await runJob(j as any));
}

const refreshedAt = new Date().toISOString();
mkdirSync("staging", { recursive: true });
writeFileSync(
  "staging/refresh-meta.json",
  JSON.stringify(
    {
      refreshed_at: refreshedAt,
      total_ms: Date.now() - started,
      sources: flatResults,
    },
    null,
    2,
  ),
);

console.error(`\n=== scrape summary (${Date.now() - started}ms) ===`);
let failed = 0;
for (const r of flatResults) {
  const tag = r.status === "ok" ? "✓" : "✗";
  const sz = r.output_bytes ? ` (${(r.output_bytes / 1024).toFixed(0)} KB)` : "";
  console.error(`  ${tag} ${r.name}${sz} ${r.ms}ms${r.status === "fail" ? "\n    " + r.err : ""}`);
  if (r.status === "fail") failed++;
}

// Exit 0 even if some sources failed — partial dataset is fine, the merge
// step will surface stale flags. Only exit non-zero if EVERYTHING failed.
if (failed === flatResults.length) {
  console.error("✗ all sources failed — bailing");
  process.exit(1);
}
