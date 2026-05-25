#!/usr/bin/env bun
// Fold merged.json into events.ndjson + projection.
//
// Performance note: the public Frame API (addEntityWithFacts / setFacts)
// rebuilds the entire SQLite projection from the events log on every call.
// That's fine for an MCP-style "one fact at a time" workload, but for a
// 700-entity initial fold it turns into O(N²) work and takes ~35 minutes.
//
// We bypass the high-level API and write events directly via the engine's
// low-level primitives (appendEvent + uuid + now), then call frame.project()
// EXACTLY ONCE at the end to materialize the SQLite projection. Same on-disk
// result, ~50× faster — the same engine, just with the projection rebuild
// hoisted out of the per-entity loop.
//
// Diff-aware semantics are preserved: we still query() for current facts
// before emitting set events, and skip when nothing stable has changed.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Frame } from "@frames-ag/frame";
import { entityIdFromHost } from "./host.ts";

// Inlined Frame engine helpers — the package's exports map doesn't expose
// these but they're load-bearing for batched writes. One-line drop-ins.
function uuid(): string {
  return randomUUID();
}
function now(): string {
  return new Date().toISOString();
}
function appendEvent(path: string, event: unknown): void {
  appendFileSync(path, JSON.stringify(event) + "\n");
}

type Merged = {
  host: string;
  display_name: string;
  description: string | null;
  category: string;
  category_source: string;
  networks_accepted: string;
  network_names: string;
  primary_network: string;
  network_count: number;
  network_tiers: string;
  on_bazaar: boolean;
  on_agentic_market: boolean;
  on_pay_sh: boolean;
  on_mppscan: boolean;
  advertises_mpp: boolean;
  advertises_x402: boolean;
  advertised_methods: string;
  advertised_networks: string;
  mpp_source: string;
  probe_status: string;
  probe_endpoint: string | null;
  listed_on_count: number;
  bazaar_resource_count: number;
  bazaar_last_updated: string | null;
  tempo_tx_count: number;
  tempo_volume_usd: number;
  tempo_latest_tx: string | null;
  volume_usd_base: number;
  volume_usd_solana: number;
  tx_count_base: number;
  tx_count_solana: number;
  x402_tx_count_30d: number;
  x402_volume_usd_30d: number;
  x402_buyers_30d: number;
  x402_facilitators: string;
  is_active_14d: boolean;
  is_mass_lister: boolean;
  is_infra: boolean;
  is_recognized: boolean;
  min_price_usd: number | null;
  max_price_usd: number | null;
  observed_at: string;
  evidence: { bazaar?: string; agentic_market?: string; paysh?: string };
};

const VOLATILE = new Set([
  "observed_at",
  "bazaar_resource_count",
  "bazaar_last_updated",
  "is_active_14d",
]);

function snapshotFor(m: Merged): Record<string, unknown> {
  const out: Record<string, unknown> = {
    host: m.host,
    display_name: m.display_name,
    category: m.category,
    category_source: m.category_source,
    networks_accepted: m.networks_accepted,
    network_names: m.network_names,
    primary_network: m.primary_network,
    network_count: m.network_count,
    network_tiers: m.network_tiers,
    on_bazaar: m.on_bazaar,
    on_agentic_market: m.on_agentic_market,
    on_pay_sh: m.on_pay_sh,
    on_mppscan: m.on_mppscan,
    advertises_mpp: m.advertises_mpp,
    advertises_x402: m.advertises_x402,
    advertised_methods: m.advertised_methods,
    advertised_networks: m.advertised_networks,
    mpp_source: m.mpp_source,
    probe_status: m.probe_status,
    listed_on_count: m.listed_on_count,
    bazaar_resource_count: m.bazaar_resource_count,
    tempo_tx_count: m.tempo_tx_count,
    tempo_volume_usd: m.tempo_volume_usd,
    volume_usd_base: m.volume_usd_base,
    volume_usd_solana: m.volume_usd_solana,
    tx_count_base: m.tx_count_base,
    tx_count_solana: m.tx_count_solana,
    x402_tx_count_30d: m.x402_tx_count_30d,
    x402_volume_usd_30d: m.x402_volume_usd_30d,
    x402_buyers_30d: m.x402_buyers_30d,
    x402_facilitators: m.x402_facilitators,
    is_active_14d: m.is_active_14d,
    is_mass_lister: m.is_mass_lister,
    is_infra: m.is_infra,
    is_recognized: m.is_recognized,
    observed_at: m.observed_at,
  };
  if (m.description) out.description = m.description;
  if (m.bazaar_last_updated) out.bazaar_last_updated = m.bazaar_last_updated;
  if (m.tempo_latest_tx) out.tempo_latest_tx = m.tempo_latest_tx;
  if (m.probe_endpoint) out.probe_endpoint = m.probe_endpoint;
  if (m.min_price_usd != null) out.min_price_usd = m.min_price_usd;
  if (m.max_price_usd != null) out.max_price_usd = m.max_price_usd;
  return out;
}

function pickSourceFor(m: Merged): { url: string; retrieved_at: string; title: string } {
  const url =
    m.evidence.agentic_market ??
    m.evidence.paysh ??
    m.evidence.bazaar ??
    `https://${m.host}`;
  return {
    url,
    retrieved_at: m.observed_at,
    title: `${m.display_name} — ${m.network_count} network${m.network_count === 1 ? "" : "s"}, ${m.bazaar_resource_count} bazaar resource${m.bazaar_resource_count === 1 ? "" : "s"}`,
  };
}

function equalish(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function diff(
  current: Record<string, unknown>,
  target: Record<string, unknown>,
): { changed: Record<string, unknown>; stable_changed: boolean } {
  const changed: Record<string, unknown> = {};
  let stable_changed = false;
  for (const [k, v] of Object.entries(target)) {
    if (!equalish(current[k], v)) {
      changed[k] = v;
      if (!VOLATILE.has(k)) stable_changed = true;
    }
  }
  return { changed, stable_changed };
}

const AGENT = "system:merchants-watch-bot";

async function main() {
  const path = resolve(process.argv[2] ?? "staging/merged.json");
  if (!existsSync(path)) {
    console.error(`merged file not found: ${path}`);
    process.exit(2);
  }
  const merged: Merged[] = JSON.parse(readFileSync(path, "utf8"));

  const frame = new Frame(process.cwd(), { agent: AGENT });

  // Snapshot current state ONCE (not per-entity) so the inner loop is fast.
  // For initial folds against an empty events.ndjson this is just {}.
  const currentByEntity = new Map<string, Record<string, unknown>>();
  try {
    const all = frame.query({ mode: "all" });
    for (const r of all.rows) {
      currentByEntity.set(r.entity_id, r.fields);
    }
  } catch {
    /* no events yet — that's fine */
  }

  let n_new = 0;
  let n_updated = 0;
  let n_unchanged = 0;
  let n_failed = 0;

  const eventsPath = frame.eventsPath;
  const started = Date.now();

  for (const m of merged) {
    const entity_id = entityIdFromHost(m.host);
    const target = snapshotFor(m);
    const source = pickSourceFor(m);

    const current = currentByEntity.get(entity_id) ?? null;

    try {
      if (!current) {
        // New entity — emit one entity.created event + one fact.set per field.
        appendEvent(eventsPath, {
          id: uuid(),
          ts: now(),
          type: "entity.created",
          agent: AGENT,
          payload: { entity_id },
        });
        for (const [field, value] of Object.entries(target)) {
          appendEvent(eventsPath, {
            id: uuid(),
            ts: now(),
            type: "fact.set",
            agent: AGENT,
            payload: {
              fact_id: uuid(),
              entity_id,
              field,
              value,
              source,
            },
          });
        }
        n_new++;
        continue;
      }

      const { changed, stable_changed } = diff(current, target);
      if (Object.keys(changed).length === 0 || !stable_changed) {
        n_unchanged++;
        continue;
      }

      for (const [field, value] of Object.entries(changed)) {
        appendEvent(eventsPath, {
          id: uuid(),
          ts: now(),
          type: "fact.set",
          agent: AGENT,
          payload: {
            fact_id: uuid(),
            entity_id,
            field,
            value,
            source,
          },
        });
      }
      n_updated++;
    } catch (e: any) {
      n_failed++;
      console.error(`  ! ${entity_id}: ${e?.message ?? e}`);
    }
  }

  const writeMs = Date.now() - started;
  console.error(`  wrote events in ${writeMs}ms — projecting…`);

  // Single projection rebuild at the end. THIS is what we hoisted out of
  // the per-entity loop. ~30s for 12k events vs ~35min when called per-entity.
  const projectStart = Date.now();
  frame.project();
  const projectMs = Date.now() - projectStart;

  console.error(
    `\n✓ ${n_new} new, ${n_updated} updated, ${n_unchanged} unchanged, ${n_failed} failed (events ${writeMs}ms, project ${projectMs}ms)`,
  );
}

main().catch((e) => {
  console.error("fold failed:", e);
  process.exit(1);
});
