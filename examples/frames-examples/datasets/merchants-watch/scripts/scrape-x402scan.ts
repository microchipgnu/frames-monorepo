#!/usr/bin/env bun
// Scrape x402scan.com — paid x402 indexer for Base + Solana settlements.
//
//   https://x402scan.com/openapi.json
//
// Cost: $0.01 per /api/x402/merchants call (paid via x402 micropayment).
// At 100 merchants/page, two calls cover Base+Solana for $0.02. Weekly
// refresh in CI is ~$0.08/month.
//
// Auth: x402 protocol. We use a `viem`-based EIP-191 signer to sign the
// payment authorization. Wallet key comes from X402_WALLET_PRIVATE_KEY,
// which must be funded with USDC on Base (no Tempo needed — Base is the
// payment rail x402scan accepts). If the key is missing, we fall back to
// staging/x402scan-cache.json — a committed snapshot from the last paid run.
//
// Output: staging/x402scan.json — one record per recipient address with
// chain, tx_count, total_amount_usd, unique_buyers, facilitator_ids.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const API = "https://x402scan.com/api/x402/merchants";
const PAGE_SIZE = 100;
const CACHE_PATH = "staging/x402scan-cache.json";
const CHAINS = ["base", "solana"] as const;
const TIMEFRAME_DAYS = 30;
const PAGES_PER_CHAIN = 5; // top 500 per chain — captures the long tail meaningfully.

type X402Merchant = {
  recipient: string;
  facilitator_ids?: string[];
  tx_count?: number;
  total_amount?: number; // USDC base units (6 decimals)
  unique_buyers?: number;
  latest_block_timestamp?: unknown;
  chains?: string[];
};

type X402Page = {
  data: X402Merchant[];
  pagination?: { has_next_page?: boolean };
};

type X402scanStaging = {
  recipient: string; // lowercase address
  chain: "base" | "solana";
  facilitator_ids: string[];
  tx_count: number;
  volume_usd_30d: number;
  unique_buyers: number;
  source_url: string;
  observed_at: string;
};

function microUsdcToUsd(v: number | undefined | null): number {
  if (!v || !Number.isFinite(v)) return 0;
  return v / 1_000_000;
}

async function fetchPageViaAgentcash(
  chain: "base" | "solana",
  page: number,
): Promise<X402Page> {
  // Use the agentcash MCP bridge — same wallet key handles x402 payments.
  // In CI, this script is invoked via `bunx agentcash@latest run` which
  // wraps fetch with payment handling. Locally, we just shell out to the
  // agentcash CLI if it's installed; otherwise we rely on the cache.
  const url = `${API}?chain=${chain}&page=${page}&page_size=${PAGE_SIZE}&sort_by=volume&timeframe=${TIMEFRAME_DAYS}`;
  // The agentcash CLI handles the x402 challenge → pay → retry cycle.
  // If unavailable (locally, in CI without an installed agentcash CLI), the
  // caller falls back to the committed cache.
  const proc = Bun.spawn({
    cmd: ["bunx", "-y", "agentcash@latest", "fetch", url],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`agentcash fetch failed (exit ${code}): ${err.slice(0, 200)}`);
  }
  return JSON.parse(text) as X402Page;
}

async function fetchAllLive(): Promise<X402scanStaging[]> {
  const observedAt = new Date().toISOString();
  const out: X402scanStaging[] = [];
  for (const chain of CHAINS) {
    for (let page = 0; page < PAGES_PER_CHAIN; page++) {
      const { data, pagination } = await fetchPageViaAgentcash(chain, page);
      for (const m of data) {
        out.push({
          recipient: m.recipient.toLowerCase(),
          chain,
          facilitator_ids: m.facilitator_ids ?? [],
          tx_count: m.tx_count ?? 0,
          volume_usd_30d: microUsdcToUsd(m.total_amount),
          unique_buyers: m.unique_buyers ?? 0,
          source_url: `${API}?chain=${chain}&page=${page}&page_size=${PAGE_SIZE}`,
          observed_at: observedAt,
        });
      }
      process.stderr.write(
        `  ${chain} page ${page}: +${data.length}, total=${out.length}\n`,
      );
      if (!pagination?.has_next_page) break;
    }
  }
  return out;
}

function loadFromCache(): X402scanStaging[] | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return (raw?.data ?? raw ?? null) as X402scanStaging[] | null;
  } catch {
    return null;
  }
}

async function main() {
  let records: X402scanStaging[];
  let stale = false;

  if (process.env.X402_WALLET_PRIVATE_KEY) {
    console.error("→ x402scan via agentcash (paid x402 micropayments)…");
    try {
      records = await fetchAllLive();
      mkdirSync("staging", { recursive: true });
      writeFileSync(
        CACHE_PATH,
        JSON.stringify(
          { data: records, refreshed_at: new Date().toISOString() },
          null,
          2,
        ),
      );
      console.error(`  refreshed ${CACHE_PATH}`);
    } catch (e) {
      console.error(`  live scrape failed: ${(e as Error).message}`);
      const cached = loadFromCache();
      if (!cached) {
        console.error("  no cache to fall back to — bailing");
        process.exit(1);
      }
      records = cached;
      stale = true;
    }
  } else {
    console.error("→ x402scan: X402_WALLET_PRIVATE_KEY not set — using committed cache");
    const cached = loadFromCache();
    if (!cached) {
      console.error(`  no ${CACHE_PATH} — first run must have wallet, exiting`);
      process.exit(1);
    }
    records = cached;
    stale = true;
  }

  if (stale) {
    console.error("  ⚠ using cached x402scan data — volumes may be stale");
  }

  mkdirSync("staging", { recursive: true });
  writeFileSync("staging/x402scan.json", JSON.stringify(records, null, 2));

  const base = records.filter((r) => r.chain === "base").length;
  const solana = records.filter((r) => r.chain === "solana").length;
  console.error(
    `✓ ${records.length} recipient records (base=${base}, solana=${solana}) → staging/x402scan.json`,
  );
}

main().catch((e) => {
  console.error("scrape-x402scan failed:", e);
  process.exit(1);
});
