#!/usr/bin/env bun
// Mirror live Bazaar (CDP x402 discovery) and MPP (mpp.dev) catalogs
// into content/tools/ as pay v0.0.1 ToolDescriptor JSON files.
//
// Run:
//   bun run scripts/refresh.ts                  # full refresh
//   bun run scripts/refresh.ts --limit 20       # sample
//   bun run scripts/refresh.ts --source bazaar  # one source only
//   bun run scripts/refresh.ts --source mpp

import { writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BAZAAR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const MPP_URL = "https://mpp.dev/api/services";
const FRAMES_REGISTRY_URL = "https://registry.frames.ag/api/services";
const OUT_DIR = resolve(__dirname, "..", "content", "tools");

const args = process.argv.slice(2);
const limitFlag = args.indexOf("--limit");
const limit = limitFlag >= 0 ? parseInt(args[limitFlag + 1] ?? "0", 10) : Infinity;
const sourceFlag = args.indexOf("--source");
const source = sourceFlag >= 0 ? args[sourceFlag + 1] : "all";

interface BazaarItem {
  resource: string;
  description?: string;
  type: string;
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    extra?: Record<string, unknown>;
    maxTimeoutSeconds?: number;
  }>;
  extensions?: Record<string, unknown>;
  lastUpdated?: string;
  quality?: { l30DaysTotalCalls?: number };
}

interface MppService {
  id: string;
  name: string;
  serviceUrl?: string;
  url?: string;
  description: string;
  categories?: string[];
  tags?: string[];
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
}

interface FramesService {
  slug: string;
  title: string;
  description: string;
  version?: string;
  tags?: string[];
  endpoints: { base: string; openapi: string };
}

interface OpenApiPath {
  [method: string]: {
    summary?: string;
    description?: string;
    tags?: string[];
    requestBody?: {
      content?: {
        "application/json"?: { schema?: unknown };
      };
    };
    security?: Array<Record<string, unknown>>;
  };
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string; description?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths?: Record<string, OpenApiPath>;
}

interface ToolDescriptor {
  pay_protocol: "0.0.1";
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  invocation: {
    method: string;
    url: string;
    params_schema?: unknown;
  };
  payment: {
    protocol: "x402" | "x402v2" | "mpp";
    network?: string;
    currency?: string;
    price_hint?: string;
  };
  _meta?: {
    catalog: "bazaar" | "mpp" | "frames-registry";
    fetched_at: string;
    upstream_id?: string;
    x402_version?: number;
    service_slug?: string;
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeNetwork(n: string): string {
  const map: Record<string, string> = {
    "eip155:1": "ethereum",
    "eip155:10": "optimism",
    "eip155:137": "polygon",
    "eip155:8453": "base",
    "eip155:84532": "base-sepolia",
    "eip155:42161": "arbitrum",
    base: "base",
  };
  if (map[n]) return map[n]!;
  if (n.startsWith("solana:")) return "solana-mainnet";
  return n;
}

function knownAssetSymbol(addr: string, network: string): string {
  const usdc: Record<string, string> = {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48-ethereum": "USDC",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913-base": "USDC",
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e-base-sepolia": "USDC",
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359-polygon": "USDC",
  };
  return usdc[`${addr.toLowerCase()}-${network}`] ?? "UNKNOWN";
}

async function fetchBazaar(): Promise<BazaarItem[]> {
  const all: BazaarItem[] = [];
  const pageSize = 100;
  let offset = 0;
  while (true) {
    const url = `${BAZAAR_URL}?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bazaar fetch failed: ${res.status}`);
    const data = (await res.json()) as { items: BazaarItem[] };
    if (!data.items?.length) break;
    all.push(...data.items);
    if (data.items.length < pageSize) break;
    offset += pageSize;
    if (offset > 5000) break; // safety
  }
  return all;
}

async function fetchMpp(): Promise<MppService[]> {
  const res = await fetch(MPP_URL);
  if (!res.ok) throw new Error(`MPP fetch failed: ${res.status}`);
  const data = (await res.json()) as { services: MppService[] };
  return data.services;
}

async function fetchFramesRegistry(): Promise<
  Array<{ service: FramesService; spec: OpenApiSpec }>
> {
  const res = await fetch(FRAMES_REGISTRY_URL);
  if (!res.ok) throw new Error(`Frames registry fetch failed: ${res.status}`);
  const data = (await res.json()) as { services: FramesService[] };
  const out: Array<{ service: FramesService; spec: OpenApiSpec }> = [];
  for (const service of data.services) {
    try {
      const specRes = await fetch(service.endpoints.openapi);
      if (!specRes.ok) {
        console.warn(`  ! ${service.slug}: openapi ${specRes.status}, skipping`);
        continue;
      }
      const spec = (await specRes.json()) as OpenApiSpec;
      out.push({ service, spec });
    } catch (e) {
      console.warn(`  ! ${service.slug}: ${(e as Error).message}, skipping`);
    }
  }
  return out;
}

function bazaarToDescriptor(
  item: BazaarItem,
  fetchedAt: string,
): ToolDescriptor | null {
  const accept = item.accepts[0];
  if (!accept) return null;
  if (accept.scheme !== "exact") return null;

  const network = normalizeNetwork(accept.network);
  const currency = knownAssetSymbol(accept.asset, network);
  const decimals = (accept.extra?.["decimals"] as number) ?? 6;
  const amount = parseInt(accept.amount, 10) / Math.pow(10, decimals);

  const urlSlug = slugify(item.resource.replace(/^https?:\/\//, ""));
  const id = `bazaar.${urlSlug}`;
  const protocol = item.x402Version === 2 ? "x402v2" : "x402";

  const capabilities: string[] = [];
  const bazaarExt = item.extensions?.["bazaar"] as
    | { tags?: string[] }
    | undefined;
  if (Array.isArray(bazaarExt?.tags)) capabilities.push(...bazaarExt.tags);
  if (capabilities.length === 0) capabilities.push("unspecified");

  return {
    pay_protocol: "0.0.1",
    id,
    title: (item.description ?? item.resource).slice(0, 80),
    description:
      item.description ?? `${item.type.toUpperCase()} resource at ${item.resource}`,
    capabilities,
    invocation: {
      method: "POST",
      url: item.resource,
    },
    payment: {
      protocol,
      network,
      currency,
      price_hint: amount.toString(),
    },
    _meta: {
      catalog: "bazaar",
      fetched_at: fetchedAt,
      upstream_id: item.resource,
      x402_version: item.x402Version,
    },
  };
}

// Parse "**Paid endpoint** - $0.005 on Base (USDC, USDT), Solana ..."
// Returns { price, networks, currency } best-effort.
function parseFramesPricing(desc: string | undefined): {
  price?: string;
  network?: string;
  currency?: string;
} {
  if (!desc) return {};
  const priceMatch = desc.match(/\$([0-9]+\.?[0-9]*)/);
  const price = priceMatch ? priceMatch[1] : undefined;
  // First chain mentioned wins
  let network: string | undefined;
  if (/base/i.test(desc) && !/base sepolia/i.test(desc)) network = "base";
  else if (/base sepolia/i.test(desc)) network = "base-sepolia";
  else if (/solana/i.test(desc)) network = "solana-mainnet";
  // Currency: USDC default
  const currency = /USDC/i.test(desc) ? "USDC" : undefined;
  return { price, network, currency };
}

function framesToDescriptors(
  service: FramesService,
  spec: OpenApiSpec,
  fetchedAt: string,
): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  const baseUrl = spec.servers?.[0]?.url ?? service.endpoints.base;
  const paths = spec.paths ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const m = method.toUpperCase();
      // Only include operations that declare x402 security
      const hasX402 = op.security?.some((s) => Object.keys(s).includes("x402"));
      if (!hasX402) continue;

      const id = `frames.${slugify(service.slug)}.${m.toLowerCase()}.${slugify(path)}`;
      const pricing = parseFramesPricing(op.description);
      const params_schema =
        op.requestBody?.content?.["application/json"]?.schema;

      out.push({
        pay_protocol: "0.0.1",
        id,
        title: op.summary ?? `${service.title} — ${m} ${path}`,
        description: op.description ?? service.description,
        capabilities: service.tags?.length ? service.tags : ["unspecified"],
        invocation: {
          method: m,
          url: `${baseUrl}${path}`,
          ...(params_schema ? { params_schema } : {}),
        },
        payment: {
          protocol: "x402v2",
          network: pricing.network ?? "base",
          currency: pricing.currency ?? "USDC",
          ...(pricing.price ? { price_hint: pricing.price } : {}),
        },
        _meta: {
          catalog: "frames-registry",
          fetched_at: fetchedAt,
          upstream_id: `${service.slug}:${m}:${path}`,
          service_slug: service.slug,
        },
      });
    }
  }
  return out;
}

function mppToDescriptors(
  service: MppService,
  fetchedAt: string,
): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  const baseUrl = service.serviceUrl ?? service.url;
  if (!baseUrl) return out;

  const capabilities = [
    ...(service.tags ?? []),
    ...(service.categories ?? []),
  ].filter((x, i, a) => a.indexOf(x) === i);

  for (const ep of service.endpoints) {
    if (!ep.payment) continue;
    const path = ep.path ?? "";
    const method = (ep.method ?? "POST").toUpperCase();
    const id = `mpp.${slugify(service.id)}.${method.toLowerCase()}.${slugify(path)}`;
    const decimals = ep.payment.decimals ?? 6;
    const priceHint = ep.payment.dynamic
      ? "dynamic"
      : ep.payment.amount
        ? (parseInt(ep.payment.amount, 10) / Math.pow(10, decimals)).toString()
        : undefined;

    out.push({
      pay_protocol: "0.0.1",
      id,
      title: `${service.name} — ${method} ${path}`.slice(0, 80),
      description: ep.description ?? service.description,
      capabilities: capabilities.length ? capabilities : ["unspecified"],
      invocation: {
        method,
        url: `${baseUrl}${path}`,
      },
      payment: {
        protocol: "mpp",
        currency: ep.payment.currency,
        ...(priceHint !== undefined ? { price_hint: priceHint } : {}),
      },
      _meta: {
        catalog: "mpp",
        fetched_at: fetchedAt,
        upstream_id: `${service.id}:${method}:${path}`,
      },
    });
  }
  return out;
}

function writeDescriptor(d: ToolDescriptor) {
  const path = resolve(OUT_DIR, `${d.id}.json`);
  writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
}

function writeIndex(all: ToolDescriptor[]) {
  // Sort by id for deterministic diffs
  const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = sorted.map((d) => JSON.stringify(d)).join("\n") + "\n";
  const path = resolve(OUT_DIR, "..", "index.ndjson");
  writeFileSync(path, lines);
}

async function main() {
  if (!Number.isFinite(limit)) {
    console.log("Full refresh — wiping content/tools/");
    rmSync(OUT_DIR, { recursive: true, force: true });
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const fetchedAt = new Date().toISOString();
  const bazaar: ToolDescriptor[] = [];
  const mpp: ToolDescriptor[] = [];

  if (source === "all" || source === "bazaar") {
    console.log("Fetching Bazaar…");
    const items = await fetchBazaar();
    console.log(`  ${items.length} items returned`);
    for (const item of items) {
      const d = bazaarToDescriptor(item, fetchedAt);
      if (d) bazaar.push(d);
      if (bazaar.length >= limit) break;
    }
    console.log(`  ${bazaar.length} kept after normalization`);
  }

  if (source === "all" || source === "mpp") {
    console.log("Fetching MPP…");
    const services = await fetchMpp();
    console.log(`  ${services.length} services returned`);
    for (const service of services) {
      const ds = mppToDescriptors(service, fetchedAt);
      mpp.push(...ds);
      if (mpp.length >= limit) break;
    }
    if (mpp.length > limit) mpp.length = limit;
    console.log(`  ${mpp.length} paid endpoints kept`);
  }

  const frames: ToolDescriptor[] = [];
  if (source === "all" || source === "frames") {
    console.log("Fetching Frames Registry…");
    const services = await fetchFramesRegistry();
    console.log(`  ${services.length} services with OpenAPI specs`);
    for (const { service, spec } of services) {
      const ds = framesToDescriptors(service, spec, fetchedAt);
      frames.push(...ds);
      if (frames.length >= limit) break;
    }
    if (frames.length > limit) frames.length = limit;
    console.log(`  ${frames.length} x402 endpoints kept`);
  }

  const all = [...bazaar, ...mpp, ...frames];
  for (const d of all) writeDescriptor(d);
  writeIndex(all);

  const finalCount = readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")).length;
  console.log(`\nWrote ${all.length} new descriptors`);
  console.log(`  ${bazaar.length} from Bazaar`);
  console.log(`  ${mpp.length} from MPP`);
  console.log(`  ${frames.length} from Frames Registry`);
  console.log(`Total in content/tools/: ${finalCount}`);
  console.log(`Index: content/index.ndjson (${all.length} lines)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
