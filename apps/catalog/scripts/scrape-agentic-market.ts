#!/usr/bin/env bun
// Scrape agentic.market — paginate /v1/services until exhausted.
// Output: staging/agentic-market.json (one record per service, keyed by host).
//
// agentic.market gives us friendly display_name, descriptions, category, and
// listed pricing — the enrichment layer over the bazaar's raw resource view.
// Rate-limit tolerant: returns partial data rather than failing the tick.

import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";

const API = "https://api.agentic.market";
const PAGE_LIMIT = 100;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const REFERER = "https://agentic.market/";

type AgenticService = {
  id?: string;
  name?: string;
  description?: string;
  domain?: string;
  provider?: string;
  providerUrl?: string;
  category?: string;
  networks?: string[];
  endpoints?: { url?: string; pricing?: { amount?: string } }[];
  integrationType?: string;
  priceSummary?: {
    minAmount?: string;
    maxAmount?: string;
    avgCostPerTransaction?: string;
    currency?: string;
  };
};

export type AgenticMerchant = {
  host: string;
  service_id: string | null;
  display_name: string | null;
  description: string | null;
  category: string | null;
  networks: string[];
  endpoint_count: number;
  min_price_usd: number | null;
  max_price_usd: number | null;
  source_url: string;
  observed_at: string;
};

function parseUsd(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function fetchPage(
  offset: number,
): Promise<{ services: AgenticService[]; rateLimited: boolean }> {
  const url = `${API}/v1/services?limit=${PAGE_LIMIT}&offset=${offset}`;
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: "https://agentic.market",
        Referer: REFERER,
      },
    });
    if (res.ok) {
      const json = await res.json();
      return { services: (json.services ?? []) as AgenticService[], rateLimited: false };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const ra = Number(res.headers.get("retry-after"));
      const backoff = Math.min(30_000, 2 ** attempt * 2000);
      const sleepMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff;
      attempt++;
      console.error(`  [${res.status}] offset=${offset}, attempt ${attempt}, sleeping ${sleepMs}ms`);
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }
    console.error(
      `  [${res.status}] offset=${offset}, giving up — agentic.market is enrichment, partial data is fine`,
    );
    return { services: [], rateLimited: true };
  }
}

async function main() {
  const observedAt = new Date().toISOString();
  console.error("→ paginating api.agentic.market…");

  const all: AgenticService[] = [];
  let offset = 0;
  let cappedByRateLimit = false;
  while (true) {
    const { services, rateLimited } = await fetchPage(offset);
    all.push(...services);
    process.stderr.write(`  offset=${offset}: +${services.length}, total=${all.length}\n`);
    if (rateLimited) {
      cappedByRateLimit = true;
      break;
    }
    if (services.length < PAGE_LIMIT) break;
    offset += services.length;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (cappedByRateLimit) {
    console.error(
      `  ⚠ agentic.market rate-capped at ${all.length} services (enrichment still useful)`,
    );
  }

  const byHost = new Map<string, AgenticMerchant>();
  for (const s of all) {
    const host = canonicalHost(s.domain ?? s.providerUrl ?? null);
    if (!host) continue;
    if (byHost.has(host)) continue;

    byHost.set(host, {
      host,
      service_id: s.id ?? null,
      display_name: s.name ?? null,
      description: s.description?.slice(0, 400) ?? null,
      category: s.category && s.category.trim() ? s.category : null,
      networks: Array.isArray(s.networks) ? [...new Set(s.networks)] : [],
      endpoint_count: Array.isArray(s.endpoints) ? s.endpoints.length : 0,
      min_price_usd: parseUsd(s.priceSummary?.minAmount),
      max_price_usd: parseUsd(s.priceSummary?.maxAmount),
      source_url: `${API}/v1/services/${s.id ?? ""}`,
      observed_at: observedAt,
    });
  }

  console.error(`  ${byHost.size} merchants from ${all.length} services`);
  mkdirSync("staging", { recursive: true });
  writeFileSync(
    "staging/agentic-market.json",
    JSON.stringify([...byHost.values()], null, 2),
  );
  console.error(
    `✓ wrote staging/agentic-market.json (${byHost.size} merchants, capped=${cappedByRateLimit})`,
  );
}

main().catch((e) => {
  console.error("scrape-agentic-market failed:", e);
  process.exit(1);
});
