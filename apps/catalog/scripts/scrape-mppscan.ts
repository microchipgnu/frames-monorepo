#!/usr/bin/env bun
// Scrape mppscan.com — the on-chain indexer of MPP/Tempo settlements.
//
// mppscan is SIWX-protected (free, but every request needs a signed wallet
// proof). siwx.ts handles EIP-4361 message construction and EIP-191 signing
// via viem. Wallet key comes from MPPSCAN_WALLET_PRIVATE_KEY — any Base
// address works; no funds required (identity, not payment).
//
// If the wallet key is missing, falls back to staging/mppscan-cache.json —
// a committed snapshot from the last authenticated run. Directory stays
// accurate; volume figures freeze.
//
// Output: staging/mppscan.json — per-host Tempo tx_count, volume_usd,
// buyers, latest_tx, mpp_resource_count, rank.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";
import { siwxFromEnv, type SiwxClient } from "./siwx.ts";

const API = "https://mppscan.com/api/mpp/services";
const PAGE_SIZE = 100;
const CACHE_PATH = "staging/mppscan-cache.json";

type Service = {
  id: string;
  name?: string;
  description?: string;
  url: string;
  logoUrl?: string | null;
  resourceCount?: number;
  stats?: {
    transactions?: number;
    volume?: number;
    buyers?: number;
    latestTx?: string;
  };
  rank?: number;
};

export type MppscanMerchant = {
  host: string;
  display_name: string | null;
  description: string | null;
  tempo_tx_count: number;
  tempo_volume_usd: number;
  tempo_buyers: number;
  tempo_latest_tx: string | null;
  mpp_resource_count: number;
  rank: number | null;
  source_url: string;
  observed_at: string;
};

async function fetchPage(
  client: SiwxClient,
  page: number,
): Promise<{ services: Service[]; hasNext: boolean }> {
  const url = `${API}?page=${page}&page_size=${PAGE_SIZE}`;
  const res = await client.fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`mppscan ${page}: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data: Service[];
    pagination: { has_next_page: boolean };
  };
  return {
    services: json.data ?? [],
    hasNext: json.pagination?.has_next_page ?? false,
  };
}

async function fetchAllLive(client: SiwxClient): Promise<Service[]> {
  const all: Service[] = [];
  let page = 0;
  while (true) {
    const { services, hasNext } = await fetchPage(client, page);
    all.push(...services);
    process.stderr.write(`  page ${page}: +${services.length}, total=${all.length}\n`);
    if (!hasNext) break;
    page++;
    if (page > 50) {
      console.error("  bailout: >50 pages, something's off");
      break;
    }
  }
  return all;
}

function loadFromCache(): Service[] | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return (raw?.data ?? []) as Service[];
  } catch (e) {
    console.error(`  cache parse failed: ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  const observedAt = new Date().toISOString();
  const client = siwxFromEnv();

  let services: Service[];
  let stale = false;

  if (client) {
    console.error(`→ mppscan via SIWX (wallet ${client.address})…`);
    try {
      services = await fetchAllLive(client);
      mkdirSync("staging", { recursive: true });
      writeFileSync(
        CACHE_PATH,
        JSON.stringify({ data: services, refreshed_at: observedAt }, null, 2),
      );
      console.error(`  refreshed ${CACHE_PATH}`);
    } catch (e) {
      console.error(`  live scrape failed: ${(e as Error).message}`);
      const cached = loadFromCache();
      if (!cached) {
        console.error("  no cache to fall back to — bailing");
        process.exit(1);
      }
      services = cached;
      stale = true;
    }
  } else {
    console.error("→ mppscan: MPPSCAN_WALLET_PRIVATE_KEY not set — using committed cache");
    const cached = loadFromCache();
    if (!cached) {
      console.error(`  no ${CACHE_PATH} — first run must have wallet, exiting`);
      // Write empty so downstream merge.ts doesn't crash on missing file.
      mkdirSync("staging", { recursive: true });
      writeFileSync("staging/mppscan.json", "[]");
      process.exit(0);
    }
    services = cached;
    stale = true;
  }

  if (stale) {
    console.error("  ⚠ using cached mppscan data — Tempo volume figures may be stale");
  }

  const byHost = new Map<string, MppscanMerchant>();
  for (const s of services) {
    const host = canonicalHost(s.url);
    if (!host) continue;
    const rec: MppscanMerchant = {
      host,
      display_name: s.name ?? null,
      description: (s.description ?? "").slice(0, 400) || null,
      tempo_tx_count: Number(s.stats?.transactions) || 0,
      tempo_volume_usd: Number(s.stats?.volume) || 0,
      tempo_buyers: Number(s.stats?.buyers) || 0,
      tempo_latest_tx: s.stats?.latestTx ?? null,
      mpp_resource_count: Number(s.resourceCount) || 0,
      rank: s.rank ?? null,
      source_url: `https://mppscan.com/services/${s.id}`,
      observed_at: observedAt,
    };
    const prev = byHost.get(host);
    if (!prev || rec.tempo_tx_count > prev.tempo_tx_count) byHost.set(host, rec);
  }

  mkdirSync("staging", { recursive: true });
  writeFileSync(
    "staging/mppscan.json",
    JSON.stringify([...byHost.values()], null, 2),
  );
  console.error(
    `✓ ${byHost.size} merchants on Tempo (via mppscan) → staging/mppscan.json (stale=${stale})`,
  );
}

main().catch((e) => {
  console.error("scrape-mppscan failed:", e);
  process.exit(1);
});
