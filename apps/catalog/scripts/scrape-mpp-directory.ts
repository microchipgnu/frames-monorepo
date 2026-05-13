#!/usr/bin/env bun
// Scrape mpp.dev — the MPP service directory (Anthropic, AgentMail, Wolfram).
// Different from mppscan.com (the on-chain indexer). mpp.dev gives us the
// service catalog with endpoint-level payment metadata; mppscan tells us
// who's actually receiving Tempo settlements.
//
// Writes TWO files:
//   - staging/mpp-directory-services.json : raw services w/ endpoints (descriptor input)
//   - staging/mpp-directory-merchants.json : per-host rollup (merchant-entity input)

import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";

const MPP_URL = "https://mpp.dev/api/services";
const UA = "frames-ag-catalog-bot";

export type MppService = {
  id: string;
  name: string;
  serviceUrl?: string;
  url?: string;
  description: string;
  categories?: string[];
  tags?: string[];
  /**
   * Service-level declaration of accepted networks + assets.
   * Shape: { tempo: { intents: ["charge"], assets: ["0x..."] } }
   */
  methods?: Record<string, { intents?: string[]; assets?: string[] }>;
  endpoints: Array<{
    method: string;
    path: string;
    description?: string;
    payment?: {
      intent?: string;
      method?: string;
      currency?: string;
      decimals?: number;
      amount?: string;
      dynamic?: boolean;
    } | null;
  }>;
};

export type MppDirectoryMerchant = {
  host: string;
  service_id: string;
  display_name: string;
  description: string | null;
  categories: string[];
  tags: string[];
  endpoint_count: number;
  paid_endpoint_count: number;
  networks: string[]; // payment.method values across endpoints
  has_dynamic_pricing: boolean;
  min_price_usd: number | null;
  max_price_usd: number | null;
  source_url: string;
  observed_at: string;
};

function parsePriceUsd(
  p: { amount?: string; decimals?: number; dynamic?: boolean } | null | undefined,
): number | null {
  if (!p?.amount || p.dynamic) return null;
  const decimals = p.decimals ?? 6;
  const n = Number(p.amount);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, decimals);
}

async function fetchMpp(): Promise<MppService[]> {
  let attempt = 0;
  while (true) {
    const res = await fetch(MPP_URL, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as { services: MppService[] };
      return data.services ?? [];
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const backoff = Math.min(30_000, 2 ** attempt * 2000);
      attempt++;
      console.error(`  [${res.status}] attempt ${attempt}, sleeping ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    throw new Error(`mpp.dev: HTTP ${res.status}`);
  }
}

async function main() {
  const observedAt = new Date().toISOString();
  console.error("→ mpp.dev /api/services…");

  const services = await fetchMpp();
  console.error(`  ${services.length} services returned`);

  const byHost = new Map<string, MppDirectoryMerchant>();
  for (const s of services) {
    const baseUrl = s.serviceUrl ?? s.url;
    const host = canonicalHost(baseUrl ?? null);
    if (!host) continue;

    const networks = new Set<string>();
    let paidCount = 0;
    let hasDynamic = false;
    const prices: number[] = [];
    for (const ep of s.endpoints ?? []) {
      if (!ep.payment) continue;
      paidCount++;
      if (ep.payment.method) networks.add(ep.payment.method);
      if (ep.payment.dynamic) hasDynamic = true;
      const p = parsePriceUsd(ep.payment);
      if (p !== null && p > 0) prices.push(p);
    }

    // Service-level methods declaration adds any methods the endpoints don't
    // list explicitly (some services declare methods top-level only).
    for (const m of Object.keys(s.methods ?? {})) networks.add(m);

    byHost.set(host, {
      host,
      service_id: s.id,
      display_name: s.name,
      description: (s.description ?? "").slice(0, 400) || null,
      categories: s.categories ?? [],
      tags: s.tags ?? [],
      endpoint_count: s.endpoints?.length ?? 0,
      paid_endpoint_count: paidCount,
      networks: [...networks],
      has_dynamic_pricing: hasDynamic,
      min_price_usd: prices.length ? Math.min(...prices) : null,
      max_price_usd: prices.length ? Math.max(...prices) : null,
      source_url: `https://mpp.dev/api/services/${s.id}`,
      observed_at: observedAt,
    });
  }

  console.error(`  ${byHost.size} merchants from ${services.length} services`);
  mkdirSync("staging", { recursive: true });
  writeFileSync(
    "staging/mpp-directory-services.json",
    JSON.stringify(services, null, 2),
  );
  writeFileSync(
    "staging/mpp-directory-merchants.json",
    JSON.stringify([...byHost.values()], null, 2),
  );
  console.error("✓ wrote staging/mpp-directory-services.json + mpp-directory-merchants.json");
}

main().catch((e) => {
  console.error("scrape-mpp-directory failed:", e);
  process.exit(1);
});
