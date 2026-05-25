#!/usr/bin/env bun
// Probe each frames-registry paid endpoint with POST {} and parse the
// 402 response body's `accepts[]` to capture the seller's actual multi-rail
// payment manifest — including currencies and asset addresses that the
// /offer endpoint omits.
//
// Motivation (2026-05-25): registry.frames.ag/api/service/<slug>/offer only
// lists `{network, networkName, type}` per route. The real per-rail data
// — currency, asset contract/mint, permit2/feePayer extras — only lives in
// each seller's live 402 challenge body. For exa specifically, /offer
// claims [Base, Solana] but the live 402 advertises 5 (network, asset)
// pairs: Base/USDC, Base/USDT, Solana/USDC, Solana/USDT, Solana/CASH.
//
// Reads:
//   - staging/frames-registry-services.json (output of scrape-frames-registry.ts)
//
// Writes:
//   - staging/frames-registry-402-probes.json — array of per-route probes
//
// Cost: free. The seller returns 402 with the manifest WITHOUT us actually
// paying. We send `POST {}` and read the response body.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { FramesServiceWithSpec } from "./scrape-frames-registry.ts";

const STAGING_IN = "staging/frames-registry-services.json";
const STAGING_OUT = "staging/frames-registry-402-probes.json";
const UA = "frames-ag-catalog-bot";
const TIMEOUT_MS = 8_000;
const PARALLEL = 8;

/**
 * One entry from the seller's 402 `accepts[]` array. Mirrors x402 v2.
 * Forwarding unknown extras (permit2, feePayer, tokenProgram, …) is
 * intentional — pay does not interpret them.
 */
export interface X402AcceptsEntry {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface RouteProbe {
  service_slug: string;
  route: string; // "POST /api/search"
  status: "ok" | "no_payment_required" | "non_402" | "no_body_accepts" | "error";
  http_status?: number;
  x402_version?: number;
  accepts?: X402AcceptsEntry[];
  error?: string;
  probed_at: string;
}

function isPaidOp(op: { security?: Array<Record<string, unknown>>; responses?: Record<string, unknown>; ["x-payment-info"]?: unknown }): boolean {
  if (op["x-payment-info"]) return true;
  if (op.responses?.["402"]) return true;
  return !!op.security?.some((s) => Object.keys(s).some((k) => k.toLowerCase() === "x402"));
}

async function probeRoute(
  baseUrl: string,
  method: string,
  path: string,
  serviceSlug: string,
): Promise<RouteProbe> {
  const url = `${baseUrl}${path}`;
  const route = `${method} ${path}`;
  const probedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: "{}",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status !== 402) {
      // Could be 200 (free endpoint), 401 (siwx), 5xx, etc. Record and move on.
      return {
        service_slug: serviceSlug,
        route,
        status: res.status >= 200 && res.status < 300 ? "no_payment_required" : "non_402",
        http_status: res.status,
        probed_at: probedAt,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return {
        service_slug: serviceSlug,
        route,
        status: "no_body_accepts",
        http_status: 402,
        error: `body parse: ${(e as Error).message}`,
        probed_at: probedAt,
      };
    }
    const b = body as { x402Version?: number; accepts?: X402AcceptsEntry[] };
    if (!Array.isArray(b.accepts) || b.accepts.length === 0) {
      return {
        service_slug: serviceSlug,
        route,
        status: "no_body_accepts",
        http_status: 402,
        ...(typeof b.x402Version === "number" && { x402_version: b.x402Version }),
        probed_at: probedAt,
      };
    }
    return {
      service_slug: serviceSlug,
      route,
      status: "ok",
      http_status: 402,
      ...(typeof b.x402Version === "number" && { x402_version: b.x402Version }),
      accepts: b.accepts,
      probed_at: probedAt,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      service_slug: serviceSlug,
      route,
      status: "error",
      error: (e as Error).message,
      probed_at: probedAt,
    };
  }
}

// Drain in chunks of PARALLEL concurrent probes.
async function probeAll(
  tasks: Array<() => Promise<RouteProbe>>,
): Promise<RouteProbe[]> {
  const out: RouteProbe[] = [];
  for (let i = 0; i < tasks.length; i += PARALLEL) {
    const chunk = tasks.slice(i, i + PARALLEL);
    const results = await Promise.all(chunk.map((t) => t()));
    out.push(...results);
  }
  return out;
}

async function main() {
  if (!existsSync(STAGING_IN)) {
    console.error(`missing ${STAGING_IN} — run \`bun run scrape:frames-registry\` first`);
    process.exit(1);
  }
  const bundles = JSON.parse(readFileSync(STAGING_IN, "utf-8")) as FramesServiceWithSpec[];

  const tasks: Array<() => Promise<RouteProbe>> = [];
  for (const bundle of bundles) {
    const { service, spec } = bundle;
    const baseUrl = spec.servers?.[0]?.url ?? service.endpoints.base;
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!isPaidOp(op)) continue;
        const m = method.toUpperCase();
        tasks.push(() => probeRoute(baseUrl, m, path, service.slug));
      }
    }
  }
  console.error(`→ probing ${tasks.length} paid routes across ${bundles.length} services (parallelism=${PARALLEL})…`);

  const probes = await probeAll(tasks);

  const counts = probes.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  mkdirSync("staging", { recursive: true });
  writeFileSync(STAGING_OUT, JSON.stringify(probes, null, 2));
  console.error(`✓ ${probes.length} probes → ${STAGING_OUT}`);
  console.error(`  status:`, JSON.stringify(counts));
}

main().catch((e) => {
  console.error("probe-402-frames-registry failed:", e);
  process.exit(1);
});
