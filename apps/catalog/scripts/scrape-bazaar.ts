#!/usr/bin/env bun
// Walk the Coinbase x402 Bazaar — canonical discovery catalog of every
// x402-settled paid HTTP resource. Free, no auth.
//
//   https://docs.cdp.coinbase.com/x402/bazaar
//
// Writes TWO files:
//   - staging/bazaar-items.json     : raw per-endpoint items (descriptor input)
//   - staging/bazaar-merchants.json : per-host rollup (merchant-entity input)
//
// Per-host rollup carries pay_to[] (join key for x402scan) and 3 sample
// resources (probe-discovery seeds).

import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";

const BAZAAR =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_LIMIT = 1000;
const UA =
  "frames-ag-catalog-bot (+https://github.com/microchipgnu/frames-monorepo)";

export type BazaarItem = {
  resource: string;
  description?: string;
  type: string;
  x402Version: number;
  accepts?: {
    scheme?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    extra?: Record<string, unknown>;
    maxTimeoutSeconds?: number;
  }[];
  extensions?: Record<string, unknown>;
  metadata?: { description?: string };
  lastUpdated?: string;
  quality?: { l30DaysTotalCalls?: number };
};

export type BazaarMerchant = {
  host: string;
  bazaar_resource_count: number;
  networks: string[];
  x402_versions: number[];
  bazaar_last_updated: string | null;
  description: string | null;
  sample_resources: { url: string; lastUpdated?: string }[];
  amounts_usd: number[];
  pay_to: string[];
  total_calls_30d: number;
  source_url: string;
  observed_at: string;
};

function amountToUsd(a: { amount?: string; asset?: string } | undefined): number | null {
  if (!a?.amount) return null;
  // USDC is 6 decimals on Base & Solana; assume that unless we learn otherwise.
  // Best-effort signal, not authoritative pricing.
  const n = Number(a.amount);
  if (!Number.isFinite(n)) return null;
  return n / 1_000_000;
}

async function fetchPage(
  offset: number,
): Promise<{ items: BazaarItem[]; total: number }> {
  const url = `${BAZAAR}?limit=${PAGE_LIMIT}&offset=${offset}`;
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.ok) {
      const json = await res.json();
      return {
        items: (json.items ?? []) as BazaarItem[],
        total: json.pagination?.total ?? 0,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = Number(res.headers.get("retry-after"));
      const backoff = Math.min(30_000, 2 ** attempt * 2000);
      const sleepMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff;
      attempt++;
      console.error(`  [${res.status}] offset=${offset}, attempt ${attempt}, sleeping ${sleepMs}ms`);
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }
    throw new Error(`bazaar offset=${offset}: HTTP ${res.status}`);
  }
}

async function main() {
  const observedAt = new Date().toISOString();
  console.error("→ walking Coinbase Bazaar…");

  const allItems: BazaarItem[] = [];
  const merchants = new Map<string, BazaarMerchant>();
  let offset = 0;
  let total = Infinity;
  let pages = 0;

  while (offset < total) {
    const { items, total: t } = await fetchPage(offset);
    total = t;
    pages++;
    process.stderr.write(
      `  page ${pages}: offset=${offset}, items=${items.length}, total=${total}\r`,
    );

    for (const it of items) {
      allItems.push(it);
      const host = canonicalHost(it.resource);
      if (!host) continue;

      let m = merchants.get(host);
      if (!m) {
        m = {
          host,
          bazaar_resource_count: 0,
          networks: [],
          x402_versions: [],
          bazaar_last_updated: null,
          description: null,
          sample_resources: [],
          amounts_usd: [],
          pay_to: [],
          total_calls_30d: 0,
          source_url: `${BAZAAR}?limit=${PAGE_LIMIT}&offset=${offset}`,
          observed_at: observedAt,
        };
        merchants.set(host, m);
      }

      m.bazaar_resource_count++;
      m.total_calls_30d += it.quality?.l30DaysTotalCalls ?? 0;
      if (it.x402Version != null && !m.x402_versions.includes(it.x402Version))
        m.x402_versions.push(it.x402Version);
      if (it.lastUpdated && (!m.bazaar_last_updated || it.lastUpdated > m.bazaar_last_updated))
        m.bazaar_last_updated = it.lastUpdated;
      if (!m.description) {
        const d = it.metadata?.description ?? it.description;
        if (d) m.description = d.slice(0, 400);
      }
      for (const a of it.accepts ?? []) {
        if (a.network && !m.networks.includes(a.network)) m.networks.push(a.network);
        const usd = amountToUsd(a);
        if (usd != null && usd > 0 && usd < 1000) m.amounts_usd.push(usd);
        if (a.payTo) {
          const addr = a.payTo.toLowerCase();
          if (!m.pay_to.includes(addr)) m.pay_to.push(addr);
        }
      }
      if (m.sample_resources.length < 3) {
        m.sample_resources.push({ url: it.resource, lastUpdated: it.lastUpdated });
      }
    }

    offset += items.length;
    if (items.length < PAGE_LIMIT) break;
    if (offset > 100_000) {
      console.error("\n  bailout: offset > 100k — pagination almost certainly busted");
      break;
    }
  }

  process.stderr.write("\n");
  console.error(
    `  ${merchants.size.toLocaleString()} unique hosts from ${total.toLocaleString()} resources`,
  );

  mkdirSync("staging", { recursive: true });
  const merchantsOut = [...merchants.values()].sort(
    (a, b) => b.bazaar_resource_count - a.bazaar_resource_count,
  );
  writeFileSync("staging/bazaar-merchants.json", JSON.stringify(merchantsOut, null, 2));
  writeFileSync("staging/bazaar-items.json", JSON.stringify(allItems, null, 2));
  console.error(
    `✓ wrote staging/bazaar-merchants.json (${merchantsOut.length} merchants)` +
      ` + staging/bazaar-items.json (${allItems.length} items)`,
  );
}

main().catch((e) => {
  console.error("scrape-bazaar failed:", e);
  process.exit(1);
});
