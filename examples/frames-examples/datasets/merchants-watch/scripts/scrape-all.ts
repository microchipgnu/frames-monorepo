#!/usr/bin/env bun
// Run all v1 scrapers in parallel (Bazaar, agentic.market, pay.sh).
// mppscan + x402scan are deferred to v2 (need wallet infra).

import { $ } from "bun";

// Catalog scrapers run in parallel — they're all independent reads of public
// indexes. probe-402 runs AFTER bazaar because it needs staging/bazaar.json
// to know which hosts (and sample endpoints) to probe.
const parallelJobs = [
  { name: "bazaar", cmd: "bun scripts/scrape-bazaar.ts" },
  { name: "agentic-market", cmd: "bun scripts/scrape-agentic-market.ts" },
  { name: "paysh", cmd: "bun scripts/scrape-paysh.ts" },
  { name: "mppscan", cmd: "bun scripts/scrape-mppscan.ts" },
  { name: "x402scan", cmd: "bun scripts/scrape-x402scan.ts" },
];
const sequentialJobs = [
  // probe-402 has a 7-day cache so re-running every refresh is cheap; only
  // hosts that haven't been probed in 7d get hit.
  { name: "probe-402", cmd: "bun scripts/probe-402.ts" },
];

const started = Date.now();
const results = await Promise.allSettled(
  parallelJobs.map(async (j) => {
    const t = Date.now();
    try {
      await $`bash -c ${j.cmd}`.quiet();
      return { name: j.name, status: "ok" as const, ms: Date.now() - t };
    } catch (e: any) {
      return { name: j.name, status: "fail" as const, ms: Date.now() - t, err: String(e) };
    }
  }),
);
for (const j of sequentialJobs) {
  const t = Date.now();
  try {
    await $`bash -c ${j.cmd}`.quiet();
    results.push({
      status: "fulfilled" as const,
      value: { name: j.name, status: "ok" as const, ms: Date.now() - t },
    });
  } catch (e: any) {
    results.push({
      status: "fulfilled" as const,
      value: { name: j.name, status: "fail" as const, ms: Date.now() - t, err: String(e) },
    });
  }
}

console.error(`\n=== scrape summary (${Date.now() - started}ms) ===`);
let failed = 0;
for (const r of results) {
  if (r.status === "fulfilled") {
    const v = r.value;
    const tag = v.status === "ok" ? "✓" : "✗";
    console.error(`  ${tag} ${v.name} (${v.ms}ms)${v.status === "fail" ? "\n    " + v.err : ""}`);
    if (v.status === "fail") failed++;
  } else {
    console.error(`  ✗ rejected: ${r.reason}`);
    failed++;
  }
}

if (failed > 0) process.exit(1);
