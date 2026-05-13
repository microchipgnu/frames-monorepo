#!/usr/bin/env bun
// Probe each bazaar host (and sibling hosts: mpp.foo.com, payments.foo.com)
// using `@agentcash/discovery` — the canonical x402 discovery library, same
// parser x402scan.com/discovery-spec uses.
//
// Captures per origin:
//   - endpoints[]      : discovered routes w/ authMode, price, protocols
//   - guidance         : OpenAPI info.x-guidance — agent-facing usage prose
//   - source           : where discovery found data ("openapi", "well-known/x402", …)
//
// 7-day cache: hosts probed within the window are reused. Pass --refresh
// to bust. Pass --limit N to cap discovery for dev.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { discoverOriginSchema, GuidanceMode } from "@agentcash/discovery";
import { canonicalHost, aliasCandidate, isInfraHost, describeNetwork } from "./host.ts";
import type { BazaarMerchant } from "./scrape-bazaar.ts";

const CACHE_PATH = "staging/probe-results.json";
const SIBLING_PREFIXES = ["mpp.", "payments.", "x402.", "api."];
const DEFAULT_MAX_AGE_DAYS = 7;
const PROBE_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const refreshFlag = args.includes("--refresh");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : Infinity;
const maxAgeIdx = args.indexOf("--max-age-days");
const maxAgeDays =
  maxAgeIdx >= 0
    ? parseInt(args[maxAgeIdx + 1] ?? `${DEFAULT_MAX_AGE_DAYS}`, 10)
    : DEFAULT_MAX_AGE_DAYS;

// Output row per probed host. Captures everything downstream merge cares
// about. `sibling_of` marks rows that aren't a seed merchant — they're a
// probed sibling like `mpp.foo.com` that credits its results back to `foo.com`.
export type ProbeRow = {
  host: string;
  probe_origin: string; // the URL we discovered against (https://<host>)
  probe_status: "ok" | "no-resources" | "timeout" | "error";
  http_status: number | null;
  has_openapi: boolean;
  x_guidance: string | null;
  resource_count: number;
  paid_resource_count: number;
  siwx_resource_count: number;
  advertised_methods: string[];   // raw protocol/method labels (e.g. "x402", "siwx")
  advertised_networks: string[];  // friendly chain names (e.g. ["Base","Solana","Tempo"])
  advertised_recipients: string[]; // join key for x402scan
  per_route_schemas: number;       // how many routes have an input schema (steerability signal)
  sample_routes: { method: string; path: string; classification: "paid" | "siwx" | "free" }[];
  sibling_of: string | null;
  observed_at: string;
};

type CacheFile = {
  refreshed_at: string;
  results: Record<string, ProbeRow>;
};

function loadCache(): CacheFile {
  if (!existsSync(CACHE_PATH))
    return { refreshed_at: new Date(0).toISOString(), results: {} };
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheFile;
  } catch {
    return { refreshed_at: new Date(0).toISOString(), results: {} };
  }
}

function isFresh(row: ProbeRow): boolean {
  const age = Date.now() - Date.parse(row.observed_at);
  return age < maxAgeDays * 24 * 60 * 60 * 1000;
}

// Shape returned by @agentcash/discovery's discoverOriginSchema when found=true.
type DiscoveryOutput = Awaited<
  ReturnType<typeof discoverOriginSchema>
> extends infer R
  ? Extract<R, { found: true }>
  : never;

async function runDiscovery(origin: string): Promise<{
  status: ProbeRow["probe_status"];
  data?: DiscoveryOutput;
}> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await discoverOriginSchema({
      target: origin,
      guidance: GuidanceMode.Auto,
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!result.found) {
      return { status: "no-resources" };
    }
    return {
      status: result.endpoints.length === 0 ? "no-resources" : "ok",
      data: result,
    };
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === "AbortError") return { status: "timeout" };
    return { status: "error" };
  }
}

function rowFromDiscovery(
  host: string,
  origin: string,
  data: DiscoveryOutput,
  observedAt: string,
  siblingOf: string | null,
): ProbeRow {
  const endpoints = data.endpoints ?? [];
  const methods = new Set<string>();
  let paid = 0;
  let siwx = 0;
  const sample: ProbeRow["sample_routes"] = [];
  for (const ep of endpoints) {
    for (const p of ep.protocols ?? []) methods.add(p);
    if (ep.authMode === "paid" || ep.authMode === "apiKey+paid") {
      methods.add("paid");
      paid++;
    } else if (ep.authMode === "siwx") {
      methods.add("siwx");
      siwx++;
    }
    if (sample.length < 5) {
      const cls: "paid" | "siwx" | "free" =
        ep.authMode === "paid" || ep.authMode === "apiKey+paid"
          ? "paid"
          : ep.authMode === "siwx"
            ? "siwx"
            : "free";
      sample.push({ method: ep.method, path: ep.path, classification: cls });
    }
  }
  return {
    host,
    probe_origin: origin,
    probe_status: endpoints.length === 0 ? "no-resources" : "ok",
    http_status: null,
    has_openapi: data.source === "openapi",
    x_guidance: data.guidance ?? null,
    resource_count: endpoints.length,
    paid_resource_count: paid,
    siwx_resource_count: siwx,
    advertised_methods: [...methods].sort(),
    advertised_networks: [], // not exposed at L2 — would require digging into per-route L3
    advertised_recipients: [],
    per_route_schemas: 0, // L2 doesn't expose input_schema; only L3 does
    sample_routes: sample,
    sibling_of: siblingOf,
    observed_at: observedAt,
  };
}

function emptyRow(
  host: string,
  origin: string,
  status: ProbeRow["probe_status"],
  observedAt: string,
  siblingOf: string | null,
): ProbeRow {
  return {
    host,
    probe_origin: origin,
    probe_status: status,
    http_status: null,
    has_openapi: false,
    x_guidance: null,
    resource_count: 0,
    paid_resource_count: 0,
    siwx_resource_count: 0,
    advertised_methods: [],
    advertised_networks: [],
    advertised_recipients: [],
    per_route_schemas: 0,
    sample_routes: [],
    sibling_of: siblingOf,
    observed_at: observedAt,
  };
}

function siblingsOf(host: string): string[] {
  // Derive the bare host (strip known prefixes) and then candidate siblings.
  const bare = aliasCandidate(host) ?? host;
  const cands = new Set<string>();
  for (const p of SIBLING_PREFIXES) {
    const cand = `${p}${bare}`;
    if (cand !== host) cands.add(cand);
  }
  return [...cands];
}

async function probeOne(
  host: string,
  observedAt: string,
  siblingOf: string | null,
): Promise<ProbeRow> {
  const origin = `https://${host}`;
  const { status, data } = await runDiscovery(origin);
  if ((status === "ok" || status === "no-resources") && data) {
    return rowFromDiscovery(host, origin, data, observedAt, siblingOf);
  }
  return emptyRow(host, origin, status, observedAt, siblingOf);
}

async function main() {
  if (!existsSync("staging/bazaar-merchants.json")) {
    console.error("staging/bazaar-merchants.json not found — run scrape-bazaar first");
    process.exit(1);
  }
  const merchants: BazaarMerchant[] = JSON.parse(
    readFileSync("staging/bazaar-merchants.json", "utf8"),
  );

  const cache = loadCache();
  const observedAt = new Date().toISOString();

  // Seeds: every non-infra bazaar host (newest hosts first by resource count).
  // Plus a sibling sweep per seed so we catch mpp.foo.com etc.
  const seeds: { host: string; siblingOf: string | null }[] = [];
  const seen = new Set<string>();
  for (const m of merchants) {
    if (isInfraHost(m.host)) continue;
    if (!seen.has(m.host)) {
      seeds.push({ host: m.host, siblingOf: null });
      seen.add(m.host);
    }
    for (const sib of siblingsOf(m.host)) {
      if (seen.has(sib)) continue;
      seeds.push({ host: sib, siblingOf: m.host });
      seen.add(sib);
    }
  }

  const probeBudget = Number.isFinite(limit) ? Math.min(limit, seeds.length) : seeds.length;
  console.error(
    `→ discovery probe: ${seeds.length} candidates (probing up to ${probeBudget}, max-age ${maxAgeDays}d, refresh=${refreshFlag})`,
  );

  // In-process discoverOriginSchema — no child processes. Concurrency 16 is
  // I/O-bound (every probe is a few HTTP fetches), well within Node's
  // socket pool budget.
  const CONCURRENCY = 16;
  const results: Record<string, ProbeRow> = { ...cache.results };
  let done = 0;
  let queue = [...seeds.slice(0, probeBudget)];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      const cached = results[next.host];
      if (!refreshFlag && cached && isFresh(cached)) {
        done++;
        continue;
      }
      const row = await probeOne(next.host, observedAt, next.siblingOf);
      // No CLI-missing branch any more — we import the lib directly.
      results[next.host] = row;
      done++;
      if (done % 25 === 0) {
        process.stderr.write(`  probed ${done}/${probeBudget}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const flat = Object.values(results);
  const okCount = flat.filter((r) => r.probe_status === "ok").length;
  const withGuidance = flat.filter((r) => r.x_guidance).length;
  const withOpenapi = flat.filter((r) => r.has_openapi).length;

  mkdirSync("staging", { recursive: true });
  writeFileSync(
    CACHE_PATH,
    JSON.stringify(
      { refreshed_at: observedAt, results } satisfies CacheFile,
      null,
      2,
    ),
  );
  // Also write the flat array shape merge expects.
  writeFileSync("staging/probe-results.json", JSON.stringify(flat, null, 2));
  console.error(
    `✓ probe-discovery: ${flat.length} rows (ok=${okCount}, openapi=${withOpenapi}, guidance=${withGuidance})`,
  );
}

main().catch((e) => {
  console.error("probe-discovery failed:", e);
  process.exit(1);
});
