#!/usr/bin/env bun
// Scrape pay.sh / Solana Foundation pay-skills catalog.
//   https://pay.sh/api/catalog
// Output: staging/paysh.json (one record per provider, keyed by host).

import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";

const CATALOG = "https://pay.sh/api/catalog";
const UA = "merchants-watch-bot";

type Provider = {
  fqn?: string;
  title?: string;
  description?: string;
  category?: string;
  service_url?: string;
  endpoint_count?: number;
  has_metering?: boolean;
  has_free_tier?: boolean;
  min_price_usd?: number;
  max_price_usd?: number;
  sha?: string;
};

type PaymStaging = {
  host: string;
  fqn: string;
  display_name: string | null;
  description: string | null;
  category: string | null;
  endpoint_count: number;
  has_metering: boolean;
  has_free_tier: boolean;
  min_price_usd: number | null;
  max_price_usd: number | null;
  source_url: string;
  observed_at: string;
};

async function main() {
  const observedAt = new Date().toISOString();
  console.error("→ pay.sh /api/catalog…");

  const res = await fetch(CATALOG, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`pay.sh: HTTP ${res.status}`);
  const json = await res.json();
  const providers: Provider[] = json.providers ?? [];

  const byHost = new Map<string, PaymStaging>();
  for (const p of providers) {
    const host = canonicalHost(p.service_url ?? null);
    if (!host || !p.fqn) continue;
    if (byHost.has(host)) continue;

    byHost.set(host, {
      host,
      fqn: p.fqn,
      display_name: p.title ?? null,
      description: (p.description ?? "").slice(0, 400) || null,
      category: p.category ?? null,
      endpoint_count: p.endpoint_count ?? 0,
      has_metering: !!p.has_metering,
      has_free_tier: !!p.has_free_tier,
      min_price_usd:
        typeof p.min_price_usd === "number" ? p.min_price_usd : null,
      max_price_usd:
        typeof p.max_price_usd === "number" ? p.max_price_usd : null,
      source_url: `https://pay.sh/services/${p.fqn}`,
      observed_at: observedAt,
    });
  }

  console.error(`  ${byHost.size} hosts from ${providers.length} providers`);
  mkdirSync("staging", { recursive: true });
  writeFileSync("staging/paysh.json", JSON.stringify([...byHost.values()], null, 2));
  console.error("✓ wrote staging/paysh.json");
}

main().catch((e) => {
  console.error("scrape-paysh failed:", e);
  process.exit(1);
});
