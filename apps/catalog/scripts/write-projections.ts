#!/usr/bin/env bun
// Take staging/merchants.json + raw items, produce two projections:
//
//   1. content/tools/<id>.json  + content/index.ndjson
//      Per-endpoint ToolDescriptor (pay v0.0.1 wire format, unchanged).
//      Stamps a `_signals` block from the merchant entity for steering.
//
//   2. content/merchants/<host>.json + content/merchants.ndjson
//      Per-host MerchantEntity with embedded tools[] sub-list of its
//      descriptor IDs.
//
// Slug collisions: when two normalized IDs collide, append a short content
// hash. Fixes the known C0.6 issue where the second descriptor silently
// overwrote the first.

import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { canonicalHost, aliasCandidate } from "./host.ts";
import type { MerchantEntity } from "./merge.ts";
import type { BazaarItem } from "./scrape-bazaar.ts";
import type { MppService } from "./scrape-mpp-directory.ts";
import type {
  FramesServiceWithSpec,
  FramesOffer,
  FramesOfferRoute,
  OpenApiOp,
} from "./scrape-frames-registry.ts";

const ROOT = resolve(import.meta.dir, "..");
const CONTENT_ROOT = resolve(ROOT, "content");
const TOOLS_DIR = resolve(CONTENT_ROOT, "tools");
const MERCHANTS_DIR = resolve(CONTENT_ROOT, "merchants");

interface PaymentOption {
  protocol: "x402" | "x402v2" | "mpp";
  network?: string;
  currency?: string;
  asset?: string;
  price_hint?: string;
  pay_to?: string;
  scheme?: string;
  extra?: Record<string, unknown>;
}

const LIST_DESCRIPTION_MAX = 140;

// Slim list-view of a ToolDescriptor — what the /catalog and /search index
// files contain. Drops heavy/redundant fields:
//   - payment.accepts[] / extra / asset / pay_to / scheme  (full set on /tools/:id)
//   - invocation.params_schema  (full schema on /tools/:id)
//   - _meta.upstream_id (duplicates invocation.url) / fetched_at (duplicates _signals.observed_at)
//   - description truncated to 200 chars (full text on /tools/:id)
// List-index entry. Carries `host` as a top-level join key into
// `content/merchants.ndjson`; the server resolves quality/category/active/
// rail filters by looking up the merchant entity at request time. Avoids
// repeating per-merchant signals across (e.g. orbisapi's 32k) tools.
interface SlimToolDescriptor {
  pay_protocol: "0.0.1";
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  invocation: { method: string; url: string };
  payment: {
    protocol: string;
    network?: string;
    currency?: string;
    price_hint?: string;
  };
  host: string | null;
  /**
   * Comma-separated network names this descriptor accepts (primary +
   * `payment.accepts[]` alternates). Lets the /catalog rail filter match
   * multi-rail descriptors whose merchant's primary network_names doesn't
   * advertise the rail. Omitted when there's only one rail (the primary).
   */
  accepts_networks?: string;
  _meta?: { catalog: string };
}

function deriveAcceptsNetworks(payment: ToolDescriptor["payment"]): string | undefined {
  const networks = new Set<string>();
  if (payment.network) networks.add(payment.network);
  if (Array.isArray(payment.accepts)) {
    for (const opt of payment.accepts) {
      if (opt && typeof opt === "object" && typeof opt.network === "string") {
        networks.add(opt.network);
      }
    }
  }
  if (networks.size <= 1) return undefined;
  return Array.from(networks).join(",");
}

function slimDescriptor(d: ToolDescriptor): SlimToolDescriptor {
  const desc = d.description ?? "";
  const acceptsNetworks = deriveAcceptsNetworks(d.payment);
  return {
    pay_protocol: "0.0.1",
    id: d.id,
    title: d.title,
    description:
      desc.length > LIST_DESCRIPTION_MAX
        ? desc.slice(0, LIST_DESCRIPTION_MAX - 1) + "…"
        : desc,
    capabilities: d.capabilities,
    invocation: { method: d.invocation.method, url: d.invocation.url },
    payment: {
      protocol: d.payment.protocol,
      ...(d.payment.network !== undefined && { network: d.payment.network }),
      ...(d.payment.currency !== undefined && { currency: d.payment.currency }),
      ...(d.payment.price_hint !== undefined && { price_hint: d.payment.price_hint }),
    },
    host: d._signals?.host ?? null,
    ...(acceptsNetworks !== undefined && { accepts_networks: acceptsNetworks }),
    ...(d._meta?.catalog && { _meta: { catalog: d._meta.catalog } }),
  };
}

interface ToolSignals {
  // Subset of MerchantEntity relevant to a specific endpoint — host-scoped
  // so an agent can filter by these without fetching the merchant entity.
  host: string;
  is_active_14d: boolean;
  is_infra: boolean;
  is_recognized: boolean;
  is_mass_lister: boolean;
  category: string;
  network_count: number;
  network_names: string;
  listed_on_count: number;
  total_calls_30d: number;
  x402_volume_usd_30d: number;
  x_guidance: string | null;
  observed_at: string;
  // Quality bucket the descriptor falls into:
  //   "curated"   — has cross-source confirmation (listed_on_count ≥ 2) or
  //                 is_recognized or comes from a curated source (mpp /
  //                 frames-registry). Default agent-search surface.
  //   "long-tail" — single-source bazaar-only, no curated brand, but not spam.
  //                 Surfaced when agents pass quality=long-tail or quality=any.
  // Spam (title-uniform mass-listers like lowpaymentfee.com) is dropped from
  // BOTH the index AND content/tools/ entirely — not represented here.
  quality: "curated" | "long-tail";
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
  payment: PaymentOption & { accepts?: PaymentOption[] };
  _meta?: {
    catalog: "bazaar" | "mpp" | "frames-registry";
    fetched_at: string;
    upstream_id?: string;
    x402_version?: number;
    service_slug?: string;
    accept_count?: number;
  };
  _signals?: ToolSignals;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function shortHash(s: string): string {
  // Tiny non-cryptographic content hash for slug collision suffixes.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

function normalizeNetwork(n: string): string {
  const map: Record<string, string> = {
    "eip155:1": "ethereum",
    "eip155:10": "optimism",
    "eip155:137": "polygon",
    "eip155:8453": "base",
    "eip155:84532": "base-sepolia",
    "eip155:42161": "arbitrum",
    "eip155:4217": "tempo",
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

function acceptToOption(
  accept: NonNullable<BazaarItem["accepts"]>[number],
  protocol: "x402" | "x402v2",
): PaymentOption | null {
  if (accept.scheme !== "exact") return null;
  if (!accept.network) return null;
  const network = normalizeNetwork(accept.network);
  const asset = accept.asset ?? "";
  const currency = knownAssetSymbol(asset, network);
  const decimals = (accept.extra?.["decimals"] as number) ?? 6;
  const amount = parseInt(accept.amount ?? "0", 10) / Math.pow(10, decimals);
  return {
    protocol,
    network,
    currency,
    asset,
    price_hint: amount.toString(),
    pay_to: accept.payTo,
    scheme: accept.scheme,
    ...(accept.extra && { extra: accept.extra }),
  };
}

function bazaarToDescriptor(item: BazaarItem, fetchedAt: string): ToolDescriptor | null {
  if (!item.accepts || item.accepts.length === 0) return null;
  const protocol = item.x402Version === 2 ? "x402v2" : "x402";
  const options = item.accepts
    .map((a) => acceptToOption(a, protocol))
    .filter((o): o is PaymentOption => o !== null);
  if (options.length === 0) return null;
  const [canonical, ...alternates] = options;
  if (!canonical) return null;

  const urlSlug = slugify(item.resource.replace(/^https?:\/\//, ""));
  const id = `bazaar.${urlSlug}`;

  const capabilities: string[] = [];
  const bazaarExt = item.extensions?.["bazaar"] as { tags?: string[] } | undefined;
  if (Array.isArray(bazaarExt?.tags)) capabilities.push(...bazaarExt.tags);
  if (capabilities.length === 0) capabilities.push("unspecified");

  const desc = item.metadata?.description ?? item.description;
  return {
    pay_protocol: "0.0.1",
    id,
    title: (desc ?? item.resource).slice(0, 80),
    description: desc ?? `${item.type.toUpperCase()} resource at ${item.resource}`,
    capabilities,
    invocation: { method: "POST", url: item.resource },
    payment: { ...canonical, ...(alternates.length > 0 && { accepts: alternates }) },
    _meta: {
      catalog: "bazaar",
      fetched_at: fetchedAt,
      upstream_id: item.resource,
      x402_version: item.x402Version,
      accept_count: item.accepts.length,
    },
  };
}

function mppToDescriptors(service: MppService, fetchedAt: string): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  const baseUrl = service.serviceUrl ?? service.url;
  if (!baseUrl) return out;
  const capabilities = [
    ...(service.tags ?? []),
    ...(service.categories ?? []),
  ].filter((x, i, a) => a.indexOf(x) === i);

  for (const ep of service.endpoints ?? []) {
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
    const network = ep.payment.method;
    const asset =
      ep.payment.currency ?? service.methods?.[network ?? ""]?.assets?.[0];

    out.push({
      pay_protocol: "0.0.1",
      id,
      title: `${service.name} — ${method} ${path}`.slice(0, 80),
      description: ep.description ?? service.description,
      capabilities: capabilities.length ? capabilities : ["unspecified"],
      invocation: { method, url: `${baseUrl}${path}` },
      payment: {
        protocol: "mpp",
        ...(network !== undefined && { network }),
        currency: ep.payment.currency,
        ...(asset !== undefined && asset !== ep.payment.currency && { asset }),
        ...(priceHint !== undefined && { price_hint: priceHint }),
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

function priceFromOp(op: OpenApiOp): string | undefined {
  const pi = op["x-payment-info"]?.price;
  if (!pi) return undefined;
  if (pi.mode === "fixed") return pi.amount;
  if (pi.mode === "dynamic") return "dynamic";
  return undefined;
}

function networkFromOpDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  if (/base sepolia/i.test(desc)) return "base-sepolia";
  if (/base/i.test(desc)) return "base";
  if (/solana/i.test(desc)) return "solana-mainnet";
  return undefined;
}

// CAIP-2 / friendly-name → canonical pay network name. Mirrors what
// dispatch.ts and the bazaar scraper use so multi-rail descriptors stay
// addressable by the same lowercase keys (base, solana-mainnet, …).
function canonicalNetworkName(network: string): string | undefined {
  if (network.startsWith("eip155:")) {
    const chainId = network.slice("eip155:".length);
    switch (chainId) {
      case "1":
        return "ethereum";
      case "8453":
        return "base";
      case "42161":
        return "arbitrum";
      case "10":
        return "optimism";
      case "137":
        return "polygon";
      default:
        return undefined;
    }
  }
  if (network.startsWith("solana:")) {
    const cluster = network.slice("solana:".length);
    if (cluster === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") return "solana-mainnet";
    if (cluster === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wwLy85A") return "solana-devnet";
    return "solana-mainnet"; // unknown cluster falls back to mainnet
  }
  return undefined;
}

// Parse a "$0.01" → "0.01" string for payment.price_hint.
function priceHintFromOffer(price?: string): string | undefined {
  if (!price) return undefined;
  const stripped = price.replace(/^\$/, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

// Look up the offer route for a (path, method). The offer's `route` field
// is "POST /api/search" — uppercase method + space + path.
function findOfferRoute(
  offer: FramesOffer | null | undefined,
  method: string,
  path: string,
): FramesOfferRoute | undefined {
  if (!offer?.tools) return undefined;
  const wanted = `${method.toUpperCase()} ${path}`;
  return offer.tools.find((t) => t.route === wanted);
}

function framesToDescriptors(
  bundle: FramesServiceWithSpec,
  fetchedAt: string,
): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  const { service, spec, offer } = bundle;
  const baseUrl = spec.servers?.[0]?.url ?? service.endpoints.base;
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      const m = method.toUpperCase();
      const hasX402 = op.security?.some((s) => Object.keys(s).some((k) => k.toLowerCase() === "x402"));
      const hasPaymentInfo = !!op["x-payment-info"];
      if (!hasX402 && !hasPaymentInfo) continue;

      const id = `frames.${slugify(service.slug)}.${m.toLowerCase()}.${slugify(path)}`;
      const paramsSchema = op.requestBody?.content?.["application/json"]?.schema;
      const priceFromOpenApi = priceFromOp(op);

      // Prefer the /offer manifest (canonical multi-rail) over the
      // description-string sniff. /offer is the authoritative source per
      // registry.frames.ag's spec; OpenAPI doesn't carry networks.
      const offerRoute = findOfferRoute(offer, m, path);
      const offerNetworks = offerRoute?.networks
        ?.map((n) => canonicalNetworkName(n.network))
        .filter((x): x is string => typeof x === "string")
        ?? [];
      const uniqueOfferNetworks = Array.from(new Set(offerNetworks));

      // Pick primary: first offer network if any, else network sniffed from
      // op.description, else "base". Falling back to "base" matches the
      // previous behaviour and stays correct when /offer is absent.
      const primaryNetwork = uniqueOfferNetworks[0]
        ?? networkFromOpDescription(op.description)
        ?? "base";
      const alternates = uniqueOfferNetworks.slice(1);

      const offerPrice = priceHintFromOffer(offerRoute?.price);
      const priceHint = offerPrice ?? (priceFromOpenApi ? String(priceFromOpenApi) : undefined);

      out.push({
        pay_protocol: "0.0.1",
        id,
        title: op.summary ?? `${service.title} — ${m} ${path}`,
        description: op.description ?? service.description,
        capabilities: service.tags?.length ? service.tags : ["unspecified"],
        invocation: {
          method: m,
          url: `${baseUrl}${path}`,
          ...(paramsSchema ? { params_schema: paramsSchema } : {}),
        },
        payment: {
          protocol: "x402v2",
          network: primaryNetwork,
          currency: "USDC",
          ...(priceHint && { price_hint: priceHint }),
          ...(alternates.length > 0 && {
            accepts: alternates.map((network) => ({
              protocol: "x402v2",
              network,
              currency: "USDC",
              ...(priceHint && { price_hint: priceHint }),
            })),
          }),
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

// Try the descriptor's host first; if no merchant matches, try the aliased
// parent (`api.foo.com` → `foo.com`) since merge.ts rolls those up.
function resolveMerchant(
  host: string | null,
  byHost: Map<string, MerchantEntity>,
): MerchantEntity | undefined {
  if (!host) return undefined;
  const direct = byHost.get(host);
  if (direct) return direct;
  const alias = aliasCandidate(host);
  return alias ? byHost.get(alias) : undefined;
}

function signalsFor(
  host: string | null,
  byHost: Map<string, MerchantEntity>,
  observedAt: string,
  catalog: "bazaar" | "mpp" | "frames-registry" | undefined,
): ToolSignals | undefined {
  const m = resolveMerchant(host, byHost);
  if (!m) return undefined;
  // Quality:
  //   curated   — has a curated brand name (is_recognized), or comes from
  //               a vetted catalog source (mpp.dev / frames-registry).
  //               Note: listed_on_count alone is NOT enough — agentic.market
  //               mirrors the bazaar wholesale, so even orbisapi appears in
  //               2 sources without any human curation.
  //   long-tail — anything else that survived the spam filter.
  const isCurated =
    catalog === "mpp" || catalog === "frames-registry" || m.is_recognized;
  return {
    host: m.host,
    is_active_14d: m.is_active_14d,
    is_infra: m.is_infra,
    is_recognized: m.is_recognized,
    is_mass_lister: m.is_mass_lister,
    category: m.category,
    network_count: m.network_count,
    network_names: m.network_names,
    listed_on_count: m.listed_on_count,
    total_calls_30d: m.total_calls_30d,
    x402_volume_usd_30d: m.x402_volume_usd_30d,
    x_guidance: m.x_guidance,
    observed_at: observedAt,
    quality: isCurated ? "curated" : "long-tail",
  };
}

// Slim-projection version of _signals — only the fields the server's
// list-route filters actually use. Drops fields agents look up via
// /merchants/<host> if they need them.
//   Kept: host, is_active_14d, is_infra, is_recognized, category,
//         network_names, quality
//   Dropped: is_mass_lister (spam filtered out), network_count (redundant),
//         listed_on_count, total_calls_30d, x402_volume_usd_30d,
//         x_guidance, observed_at
interface SlimSignals {
  host: string;
  is_active_14d: boolean;
  is_infra: boolean;
  is_recognized: boolean;
  category: string;
  network_names: string;
  quality: "curated" | "long-tail";
}
function slimSignals(s: ToolSignals): SlimSignals {
  return {
    host: s.host,
    is_active_14d: s.is_active_14d,
    is_infra: s.is_infra,
    is_recognized: s.is_recognized,
    category: s.category,
    network_names: s.network_names,
    quality: s.quality,
  };
}

// A host is "spam" iff ≥80% of its tools share a single title. Catches
// lowpaymentfee.com (10k identical "Premium API Access" entries) while
// leaving orbisapi.com alone (32k tools, 17.6k unique titles, 0.1% top
// share). Threshold + min-count keep small hosts with one-off duplicate
// titles from being flagged.
function detectSpamHosts(
  descriptors: ToolDescriptor[],
  minTools = 100,
  topShareThreshold = 0.8,
): Set<string> {
  const titlesByHost = new Map<string, Map<string, number>>();
  for (const d of descriptors) {
    const h = canonicalHost(d.invocation.url);
    if (!h) continue;
    const counts = titlesByHost.get(h) ?? new Map<string, number>();
    counts.set(d.title, (counts.get(d.title) ?? 0) + 1);
    titlesByHost.set(h, counts);
  }
  const spam = new Set<string>();
  for (const [host, counts] of titlesByHost) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total < minTools) continue;
    const top = Math.max(...counts.values());
    if (top / total >= topShareThreshold) spam.add(host);
  }
  return spam;
}

function safeReadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function main() {
  const fetchedAt = new Date().toISOString();
  const observedAt = fetchedAt;

  const merchants = safeReadJson<MerchantEntity[]>("staging/merchants.json") ?? [];
  if (merchants.length === 0) {
    console.error("staging/merchants.json missing or empty — run merge.ts first");
    process.exit(1);
  }
  const byHost = new Map(merchants.map((m) => [m.host, m]));

  const bazaarItems = safeReadJson<BazaarItem[]>("staging/bazaar-items.json") ?? [];
  const mppServices =
    safeReadJson<MppService[]>("staging/mpp-directory-services.json") ?? [];
  const framesBundles =
    safeReadJson<FramesServiceWithSpec[]>("staging/frames-registry-services.json") ?? [];

  // Wipe + recreate content dirs for a clean projection.
  if (existsSync(TOOLS_DIR)) rmSync(TOOLS_DIR, { recursive: true });
  if (existsSync(MERCHANTS_DIR)) rmSync(MERCHANTS_DIR, { recursive: true });
  mkdirSync(TOOLS_DIR, { recursive: true });
  mkdirSync(MERCHANTS_DIR, { recursive: true });

  // 1) Project tools
  const descriptors: ToolDescriptor[] = [];
  const slugSeen = new Map<string, number>(); // tracks collisions

  function pushWithCollision(d: ToolDescriptor, dedupeKey: string) {
    let id = d.id;
    if (slugSeen.has(id)) {
      const count = slugSeen.get(id)! + 1;
      slugSeen.set(id, count);
      // Append short hash for stable, non-numerical collision resolution.
      id = `${id}-${shortHash(dedupeKey)}`;
    } else {
      slugSeen.set(id, 1);
    }
    descriptors.push({ ...d, id });
  }

  for (const item of bazaarItems) {
    const d = bazaarToDescriptor(item, fetchedAt);
    if (!d) continue;
    pushWithCollision(d, item.resource);
  }
  for (const service of mppServices) {
    for (const d of mppToDescriptors(service, fetchedAt)) {
      pushWithCollision(d, d._meta?.upstream_id ?? d.id);
    }
  }
  for (const bundle of framesBundles) {
    for (const d of framesToDescriptors(bundle, fetchedAt)) {
      pushWithCollision(d, d._meta?.upstream_id ?? d.id);
    }
  }

  // Detect spam hosts (high title-uniformity) and drop their descriptors
  // entirely — they have no individual identity worth resolving.
  const spamHosts = detectSpamHosts(descriptors);
  const spamDropped = descriptors.filter((d) => {
    const h = canonicalHost(d.invocation.url);
    return h && spamHosts.has(h);
  }).length;
  const liveDescriptors = descriptors.filter((d) => {
    const h = canonicalHost(d.invocation.url);
    return !h || !spamHosts.has(h);
  });

  // Stamp signals based on the descriptor's host. Source catalog drives
  // the curated/long-tail classification.
  for (const d of liveDescriptors) {
    const host = canonicalHost(d.invocation.url);
    const sig = signalsFor(host, byHost, observedAt, d._meta?.catalog);
    if (sig) d._signals = sig;
  }

  // Write per-tool JSONs (full descriptor, served by /tools/:id).
  for (const d of liveDescriptors) {
    writeFileSync(resolve(TOOLS_DIR, `${d.id}.json`), JSON.stringify(d, null, 2) + "\n");
  }

  // Split list-index by quality so the default agent path (quality=curated)
  // pays for ~1,000 entries, not ~37,000. Long-tail bucket stays available
  // at /catalog?quality=any|long-tail; agents pay 20MB only when they ask.
  const curatedEntries: SlimToolDescriptor[] = [];
  const longtailEntries: SlimToolDescriptor[] = [];
  for (const d of liveDescriptors) {
    const slim = slimDescriptor(d);
    const m = d._signals?.host ? resolveMerchant(d._signals.host, byHost) : undefined;
    const isCurated =
      d._meta?.catalog === "mpp" ||
      d._meta?.catalog === "frames-registry" ||
      m?.is_recognized;
    (isCurated ? curatedEntries : longtailEntries).push(slim);
  }
  curatedEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  longtailEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  writeFileSync(
    resolve(CONTENT_ROOT, "index.ndjson"),
    curatedEntries.map((d) => JSON.stringify(d)).join("\n") + "\n",
  );
  writeFileSync(
    resolve(CONTENT_ROOT, "index-longtail.ndjson"),
    longtailEntries.map((d) => JSON.stringify(d)).join("\n") + "\n",
  );

  console.error(
    `   index.ndjson:          ${curatedEntries.length} curated entries`,
  );
  console.error(
    `   index-longtail.ndjson: ${longtailEntries.length} long-tail entries`,
  );
  if (spamHosts.size > 0) {
    console.error(
      `   spam-filtered (≥80% title uniformity): ${spamHosts.size} hosts, ${spamDropped} tools dropped`,
    );
    for (const h of spamHosts) console.error(`     - ${h}`);
  }

  // 2) Project merchants. Each merchant gets an embedded tools[] sub-list of
  // its descriptor IDs, sorted, so /merchants/:host can hand an agent the
  // full picture in one fetch.
  const toolsByHost = new Map<string, string[]>();
  for (const d of descriptors) {
    const h = canonicalHost(d.invocation.url);
    if (!h) continue;
    // Route the descriptor under whichever host the merchant entity uses
    // (the alias-rolled-up canonical host, not the raw URL host).
    const m = resolveMerchant(h, byHost);
    const key = m?.host ?? h;
    const arr = toolsByHost.get(key) ?? [];
    arr.push(d.id);
    toolsByHost.set(key, arr);
  }

  type PublicMerchant = MerchantEntity & {
    tools: string[]; // descriptor IDs published on this host
    catalog_protocol: "0.0.1";
    // Quality on the merchant matches the per-tool classification — a
    // merchant is curated iff it has a recognized name (or comes via a
    // vetted catalog). Server filters /catalog by joining to this.
    quality: "curated" | "long-tail";
  };
  const publicMerchants: PublicMerchant[] = merchants.map((m) => ({
    catalog_protocol: "0.0.1",
    ...m,
    tools: (toolsByHost.get(m.host) ?? []).sort(),
    quality: m.is_recognized ? "curated" : "long-tail",
  }));

  for (const m of publicMerchants) {
    // Use a safe filename — hosts contain dots which are fine for FS but
    // bazaar slugs already handle that. Use the host directly.
    writeFileSync(resolve(MERCHANTS_DIR, `${m.host}.json`), JSON.stringify(m, null, 2) + "\n");
  }
  // Sort by the same priority merge used (recognized + active + volume).
  const merchantIndexLines = publicMerchants.map((m) => JSON.stringify(m)).join("\n") + "\n";
  writeFileSync(resolve(CONTENT_ROOT, "merchants.ndjson"), merchantIndexLines);

  // Surface per-source freshness for the server (/_meta endpoint).
  if (existsSync("staging/refresh-meta.json")) {
    writeFileSync(
      resolve(CONTENT_ROOT, "refresh-meta.json"),
      readFileSync("staging/refresh-meta.json"),
    );
  }

  console.error(
    `✓ wrote ${descriptors.length} descriptors + ${publicMerchants.length} merchants`,
  );
  console.error(
    `   ${readdirSync(TOOLS_DIR).length} files in content/tools/, ${readdirSync(MERCHANTS_DIR).length} in content/merchants/`,
  );
}

main();
