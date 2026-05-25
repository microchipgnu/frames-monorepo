#!/usr/bin/env bun
// Walk the Coinbase x402 Bazaar — the canonical discovery catalog of every
// x402-settled paid HTTP resource. Free, no auth.
//
//   https://docs.cdp.coinbase.com/x402/bazaar
//
// Output: staging/bazaar.json — one record per merchant host with rolled-up
// networks accepted, resource count, last-updated, and a sample of the
// indexed resources (kept small for evidence; we don't need all 30k of
// orbisapi's).

import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";

const BAZAAR =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_LIMIT = 1000;
const UA = "merchants-watch-bot (+https://github.com/frames-engineering/merchants-watch)";

type BazaarItem = {
  resource: string;
  type: string;
  x402Version: number;
  accepts?: { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string }[];
  lastUpdated?: string;
  metadata?: { description?: string };
};

type MerchantStaging = {
  host: string;
  bazaar_resource_count: number;
  networks: string[];
  x402_versions: number[];
  bazaar_last_updated: string | null;
  description: string | null;
  sample_resources: { url: string; lastUpdated?: string }[];
  amounts_usd: number[]; // best-effort decoded from `amount` × asset (we treat USDC at 6 decimals)
  // Receiving wallet addresses, lowercased. Lets the x402scan join hit by
  // `recipient → payTo → host`. Many merchants use one address across chains
  // and one address across endpoints; some use one per chain.
  pay_to: string[];
  source_url: string;
  observed_at: string;
};

function amountToUsd(a: { amount?: string; asset?: string } | undefined): number | null {
  if (!a?.amount) return null;
  const raw = a.amount;
  // USDC has 6 decimals on Base & Solana (and most EVMs). We don't have a
  // full asset-decimals registry; assume 6 unless asset hints otherwise.
  // This is a "best effort" signal, not authoritative pricing.
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / 1_000_000;
}

async function fetchPage(offset: number): Promise<{ items: BazaarItem[]; total: number }> {
  const url = `${BAZAAR}?limit=${PAGE_LIMIT}&offset=${offset}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`bazaar ${offset}: HTTP ${res.status}`);
  const json = await res.json();
  return {
    items: (json.items ?? []) as BazaarItem[],
    total: json.pagination?.total ?? 0,
  };
}

async function main() {
  const observedAt = new Date().toISOString();
  console.error("→ walking Coinbase Bazaar…");

  const merchants = new Map<string, MerchantStaging>();
  let offset = 0;
  let total = Infinity;
  let pages = 0;

  while (offset < total) {
    const { items, total: t } = await fetchPage(offset);
    total = t;
    pages++;
    process.stderr.write(`  page ${pages}: offset=${offset}, items=${items.length}, total=${total}\r`);

    for (const it of items) {
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
          source_url: `${BAZAAR}?limit=${PAGE_LIMIT}&offset=${offset}`,
          observed_at: observedAt,
        };
        merchants.set(host, m);
      }

      m.bazaar_resource_count++;
      if (it.x402Version != null && !m.x402_versions.includes(it.x402Version))
        m.x402_versions.push(it.x402Version);
      if (it.lastUpdated && (!m.bazaar_last_updated || it.lastUpdated > m.bazaar_last_updated))
        m.bazaar_last_updated = it.lastUpdated;
      if (!m.description && it.metadata?.description)
        m.description = it.metadata.description.slice(0, 400);
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
  }

  process.stderr.write("\n");
  console.error(`  ${merchants.size.toLocaleString()} unique hosts from ${total.toLocaleString()} resources`);

  mkdirSync("staging", { recursive: true });
  const out = [...merchants.values()].sort(
    (a, b) => b.bazaar_resource_count - a.bazaar_resource_count,
  );
  writeFileSync("staging/bazaar.json", JSON.stringify(out, null, 2));
  console.error(`✓ wrote staging/bazaar.json (${out.length} merchants)`);
}

main().catch((e) => {
  console.error("scrape-bazaar failed:", e);
  process.exit(1);
});
