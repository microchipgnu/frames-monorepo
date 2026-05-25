#!/usr/bin/env bun
// Scrape mppscan.com — the on-chain index of MPP/Tempo settlements.
//
// mppscan is SIWX-protected (free, but every request needs a signed wallet
// proof). The siwx.ts helper handles the EIP-4361/SIWE message construction
// and EIP-191 signing via viem. Wallet key comes from
// MPPSCAN_WALLET_PRIVATE_KEY — any Base address works; no funds required.
//
// If the wallet key is missing (local dev without secrets), we fall back to
// staging/mppscan-cache.json — a committed snapshot from the last
// authenticated run. The cache is staleness-tolerant for the merchant
// directory but obviously freezes the volume figures.
//
// Output: staging/mppscan.json — one record per host with rolled-up Tempo
// tx_count, volume, buyers, latest_tx, resource_count.

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

type MppscanStaging = {
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
  let cacheStale = false;

  if (client) {
    console.error(`→ mppscan via SIWX (wallet ${client.address})…`);
    try {
      services = await fetchAllLive(client);
      // On a successful authenticated run, refresh the cache so a later
      // unauthenticated tick has fresh data.
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
      cacheStale = true;
    }
  } else {
    console.error(
      "→ mppscan: MPPSCAN_WALLET_PRIVATE_KEY not set — using committed cache",
    );
    const cached = loadFromCache();
    if (!cached) {
      console.error(`  no ${CACHE_PATH} — first run must have wallet, exiting`);
      process.exit(1);
    }
    services = cached;
    cacheStale = true;
  }

  if (cacheStale) {
    console.error(
      `  ⚠ using cached mppscan data — Tempo volume figures may be stale`,
    );
  }

  // Index by canonical host. Multiple MPP records on the same host are
  // unusual but possible; pick the one with the highest tx count.
  const byHost = new Map<string, MppscanStaging>();
  for (const s of services) {
    const host = canonicalHost(s.url);
    if (!host) continue;
    const rec: MppscanStaging = {
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
    `✓ ${byHost.size} merchants on Tempo (via mppscan) → staging/mppscan.json`,
  );
}

main().catch((e) => {
  console.error("scrape-mppscan failed:", e);
  process.exit(1);
});
