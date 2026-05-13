#!/usr/bin/env bun
// Scrape registry.frames.ag — first-party gateway services. Each service
// exposes an OpenAPI spec; we capture both the service catalog entry and
// the full OpenAPI doc per service for downstream descriptor projection.
//
// Per the x402scan discovery spec, OpenAPI is the canonical machine-readable
// contract. We capture:
//   - info.x-guidance (high-level agent steering prose)
//   - per-operation x-payment-info (structured pricing)
//   - per-operation security[] (x402 vs siwx classification)
//   - per-operation requestBody schema (agent input contract)
//
// Writes:
//   - staging/frames-registry-services.json : raw service + spec (descriptor input)
//   - staging/frames-registry-merchants.json : per-host rollup (merchant-entity input)

import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalHost } from "./host.ts";

const REGISTRY_URL = "https://registry.frames.ag/api/services";
const UA = "frames-ag-catalog-bot";

export type FramesService = {
  slug: string;
  title: string;
  description: string;
  version?: string;
  tags?: string[];
  endpoints: { base: string; openapi: string };
};

export type OpenApiOp = {
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: {
    content?: { "application/json"?: { schema?: unknown } };
  };
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, unknown>>;
  ["x-payment-info"]?: {
    price?:
      | { mode: "fixed"; currency: string; amount: string }
      | { mode: "dynamic"; currency: string; min: string; max: string };
    protocols?: Array<Record<string, unknown>>;
  };
};

export type OpenApiSpec = {
  openapi: string;
  info: {
    title: string;
    description?: string;
    version?: string;
    ["x-guidance"]?: string;
  };
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, OpenApiOp>>;
  components?: {
    securitySchemes?: Record<string, unknown>;
  };
};

export type FramesServiceWithSpec = {
  service: FramesService;
  spec: OpenApiSpec;
  fetched_at: string;
};

export type FramesRegistryMerchant = {
  host: string;
  service_slug: string;
  display_name: string;
  description: string | null;
  x_guidance: string | null;
  tags: string[];
  paid_endpoint_count: number;
  siwx_endpoint_count: number;
  free_endpoint_count: number;
  has_dynamic_pricing: boolean;
  min_price_usd: number | null;
  max_price_usd: number | null;
  openapi_url: string;
  source_url: string;
  observed_at: string;
};

async function fetchJson<T>(url: string, attempts = 4): Promise<T> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      const backoff = Math.min(30_000, 2 ** attempt * 2000);
      attempt++;
      console.error(`  [${res.status}] ${url}: attempt ${attempt}, sleeping ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

function classifyOp(op: OpenApiOp): "paid" | "siwx" | "free" {
  const hasPayment = !!op["x-payment-info"] || !!op.responses?.["402"];
  if (hasPayment) return "paid";
  const sec = op.security ?? [];
  for (const s of sec) {
    if (Object.keys(s).some((k) => k.toLowerCase() === "siwx")) return "siwx";
  }
  return "free";
}

function priceFromOp(op: OpenApiOp): number | null {
  const pi = op["x-payment-info"]?.price;
  if (!pi) return null;
  if (pi.mode === "fixed") {
    const n = Number(pi.amount);
    return Number.isFinite(n) ? n : null;
  }
  if (pi.mode === "dynamic") {
    const n = Number(pi.min);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function main() {
  const observedAt = new Date().toISOString();
  console.error("→ registry.frames.ag /api/services…");

  const { services } = await fetchJson<{ services: FramesService[] }>(REGISTRY_URL);
  console.error(`  ${services.length} services in registry`);

  const withSpecs: FramesServiceWithSpec[] = [];
  const merchants: FramesRegistryMerchant[] = [];
  for (const service of services) {
    let spec: OpenApiSpec;
    try {
      spec = await fetchJson<OpenApiSpec>(service.endpoints.openapi);
    } catch (e) {
      console.warn(`  ! ${service.slug}: openapi fetch failed — ${(e as Error).message}`);
      continue;
    }
    withSpecs.push({ service, spec, fetched_at: observedAt });

    const baseUrl = spec.servers?.[0]?.url ?? service.endpoints.base;
    const host = canonicalHost(baseUrl);
    if (!host) continue;

    let paid = 0;
    let siwx = 0;
    let free = 0;
    let hasDynamic = false;
    const prices: number[] = [];
    for (const methods of Object.values(spec.paths ?? {})) {
      for (const op of Object.values(methods)) {
        const cls = classifyOp(op);
        if (cls === "paid") paid++;
        else if (cls === "siwx") siwx++;
        else free++;
        if (op["x-payment-info"]?.price?.mode === "dynamic") hasDynamic = true;
        const p = priceFromOp(op);
        if (p !== null && p > 0) prices.push(p);
      }
    }

    merchants.push({
      host,
      service_slug: service.slug,
      display_name: service.title,
      description: (service.description ?? "").slice(0, 400) || null,
      x_guidance: spec.info["x-guidance"] ?? null,
      tags: service.tags ?? [],
      paid_endpoint_count: paid,
      siwx_endpoint_count: siwx,
      free_endpoint_count: free,
      has_dynamic_pricing: hasDynamic,
      min_price_usd: prices.length ? Math.min(...prices) : null,
      max_price_usd: prices.length ? Math.max(...prices) : null,
      openapi_url: service.endpoints.openapi,
      source_url: `${REGISTRY_URL}/${service.slug}`,
      observed_at: observedAt,
    });
  }

  mkdirSync("staging", { recursive: true });
  writeFileSync(
    "staging/frames-registry-services.json",
    JSON.stringify(withSpecs, null, 2),
  );
  writeFileSync(
    "staging/frames-registry-merchants.json",
    JSON.stringify(merchants, null, 2),
  );
  console.error(
    `✓ ${withSpecs.length} services w/ OpenAPI → staging/frames-registry-services.json + frames-registry-merchants.json`,
  );
}

main().catch((e) => {
  console.error("scrape-frames-registry failed:", e);
  process.exit(1);
});
