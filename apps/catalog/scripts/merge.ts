#!/usr/bin/env bun
// Merge all per-source staging files into one host-keyed merchant directory.
//
// Output:
//   staging/merchants.json — per-host MerchantEntity with all signals + per-fact evidence.
//
// Rules (consensus across sources):
//   - canonical key is `host` (already normalized in scrapers)
//   - alias rollup: x402.foo.com + api.foo.com + foo.com → foo.com when parent is seen
//   - networks_accepted = union across all sources (raw + tier labels)
//   - display_name priority: agentic.market > pay.sh > frames-registry > mpp-directory > mppscan > host
//   - description priority: agentic.market > frames-registry > pay.sh > mpp-directory > mppscan > bazaar
//   - category priority: pay.sh > frames-registry tags > agentic.market > overrides > "other"
//   - x_guidance priority: frames-registry openapi info.x-guidance > probe-discovery openapi
//   - listed_on_count = 1..N based on presence in each source
//   - is_active_14d = bazaar_last_updated within 14 days
//   - is_mass_lister = bazaar_resource_count > 500
//   - is_infra = matches one of the auto-generated host suffixes
//   - is_recognized = has curated display_name AND !infra AND !mass_lister
//   - prices: widest [min, max] across sources
//   - x402scan join: bazaar.pay_to[] → x402scan.recipient
//
// Adapted from microchipgnu/merchants-watch merge.ts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  canonicalHost,
  describeNetwork,
  isInfraHost,
  aliasCandidate,
} from "./host.ts";
import type { BazaarMerchant } from "./scrape-bazaar.ts";
import type { AgenticMerchant } from "./scrape-agentic-market.ts";
import type { PayshMerchant } from "./scrape-paysh.ts";
import type { MppDirectoryMerchant } from "./scrape-mpp-directory.ts";
import type { MppscanMerchant } from "./scrape-mppscan.ts";
import type { X402scanRecord } from "./scrape-x402scan.ts";
import type { FramesRegistryMerchant } from "./scrape-frames-registry.ts";
import type { ProbeRow } from "./probe-discovery.ts";

const OVERRIDES_PATH = "content/category-overrides.json";

const PAYSH_TAXONOMY = new Set([
  "ai_ml",
  "data",
  "search",
  "messaging",
  "maps",
  "translation",
  "security",
  "shopping",
  "media",
  "finance",
  "cloud",
  "storage",
  "devtools",
  "compute",
]);

function normalizeAgenticCategory(c: string | null): string | null {
  if (!c) return null;
  const lc = c.toLowerCase().trim();
  const aliases: Record<string, string> = {
    inference: "ai_ml",
    "ai/ml": "ai_ml",
    ai: "ai_ml",
    data: "data",
    search: "search",
    infra: "cloud",
    social: "messaging",
    media: "media",
    travel: "other",
    storage: "storage",
    trading: "finance",
    other: "other",
  };
  return aliases[lc] ?? (PAYSH_TAXONOMY.has(lc) ? lc : "other");
}

function pickFirst<T>(...candidates: (T | null | undefined)[]): T | null {
  for (const c of candidates) {
    if (c !== null && c !== undefined && c !== "") return c as T;
  }
  return null;
}

function pickDisplayName(
  host: string,
  ...candidates: (string | null | undefined)[]
): string {
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  return host.replace(/^(api|x402|www)\./, "").replace(/^./, (s) => s.toUpperCase());
}

export type MerchantEntity = {
  host: string;
  display_name: string;
  description: string | null;
  category: string;
  category_source: "pay_sh" | "frames_registry" | "agentic_market" | "claude_inferred" | "none";
  x_guidance: string | null;

  // Rail coverage
  networks_accepted: string;        // comma-sep raw IDs (audit trail)
  network_names: string;            // human-readable friendly names
  primary_network: string;
  network_count: number;
  network_tiers: string;

  // Cross-catalog presence (presence signals — listed_on_count derived)
  on_bazaar: boolean;
  on_agentic_market: boolean;
  on_pay_sh: boolean;
  on_mpp_directory: boolean;
  on_mppscan: boolean;
  on_frames_registry: boolean;
  listed_on_count: number;

  // Direct-probe advertising signals
  advertises_mpp: boolean;
  advertises_x402: boolean;
  advertises_siwx: boolean;
  advertised_methods: string;
  advertised_networks: string;
  probe_status: ProbeRow["probe_status"] | "untried";
  has_openapi: boolean;
  per_route_schemas: number;
  mpp_source: "none" | "mppscan" | "probe" | "both";

  // Activity / volume signals
  bazaar_resource_count: number;
  bazaar_last_updated: string | null;
  total_calls_30d: number;
  tempo_tx_count: number;
  tempo_volume_usd: number;
  tempo_latest_tx: string | null;
  volume_usd_base: number;
  volume_usd_solana: number;
  tx_count_base: number;
  tx_count_solana: number;
  x402_tx_count_30d: number;
  x402_volume_usd_30d: number;
  x402_buyers_30d: number;
  x402_facilitators: string;

  // Quality flags
  is_active_14d: boolean;
  is_mass_lister: boolean;
  is_infra: boolean;
  is_recognized: boolean;

  // Pricing
  min_price_usd: number | null;
  max_price_usd: number | null;

  // Endpoint count (sum across sources; superset of bazaar)
  endpoint_count: number;
  paid_endpoint_count: number;
  siwx_endpoint_count: number;

  // Provenance: source URL per fact group
  observed_at: string;
  evidence: {
    bazaar?: string;
    agentic_market?: string;
    paysh?: string;
    mpp_directory?: string;
    mppscan?: string;
    x402scan?: string;
    frames_registry?: string;
    probe?: string;
  };
};

function loadJsonOrEmpty<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T[];
  } catch {
    return [];
  }
}

function loadOverrides(): Record<string, { category: string; reason?: string }> {
  if (!existsSync(OVERRIDES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  } catch {
    return {};
  }
}

export interface MergeInputs {
  bazaar: BazaarMerchant[];
  agentic: AgenticMerchant[];
  paysh: PayshMerchant[];
  mppDir: MppDirectoryMerchant[];
  mppscan: MppscanMerchant[];
  x402scan: X402scanRecord[];
  frames: FramesRegistryMerchant[];
  probe: ProbeRow[];
  overrides: Record<string, { category: string; reason?: string }>;
}

// Pure merge — takes per-source arrays, returns the unified merchant list.
// Exported so tests can drive it with in-memory fixtures.
export function mergeMerchants(inputs: MergeInputs): MerchantEntity[] {
  const { bazaar, agentic, paysh, mppDir, mppscan, x402scan, frames, probe, overrides } = inputs;

  const bazaarByHost = new Map(bazaar.map((b) => [b.host, b]));
  const agenticByHost = new Map(agentic.map((a) => [a.host, a]));
  const payshByHost = new Map(paysh.map((p) => [p.host, p]));
  const mppDirByHost = new Map(mppDir.map((m) => [m.host, m]));
  const mppscanByHost = new Map(mppscan.map((m) => [m.host, m]));
  const framesByHost = new Map(frames.map((f) => [f.host, f]));

  // Probe-results: rows for both seed hosts AND siblings. We index by host
  // but credit sibling-ok rows back to the seed when the seed didn't probe
  // a real 402 itself.
  const probeByHost = new Map<string, ProbeRow>();
  for (const p of probe) {
    probeByHost.set(p.host, p);
    if (p.sibling_of && p.probe_status === "ok") {
      const existing = probeByHost.get(p.sibling_of);
      if (!existing || existing.probe_status !== "ok") {
        probeByHost.set(p.sibling_of, { ...p, host: p.sibling_of });
      } else {
        // Merge methods/networks/recipients into the seed entry.
        probeByHost.set(p.sibling_of, {
          ...existing,
          advertised_methods: [
            ...new Set([...existing.advertised_methods, ...p.advertised_methods]),
          ].sort(),
          advertised_networks: [
            ...new Set([...existing.advertised_networks, ...p.advertised_networks]),
          ].sort(),
          advertised_recipients: [
            ...new Set([...existing.advertised_recipients, ...p.advertised_recipients]),
          ].sort(),
          siwx_resource_count: existing.siwx_resource_count + p.siwx_resource_count,
          paid_resource_count: existing.paid_resource_count + p.paid_resource_count,
          x_guidance: existing.x_guidance ?? p.x_guidance,
        });
      }
    }
  }

  // x402scan join: key by recipient address.
  const x402ByAddress = new Map<string, X402scanRecord[]>();
  for (const r of x402scan) {
    const addr = r.recipient.toLowerCase();
    const arr = x402ByAddress.get(addr) ?? [];
    arr.push(r);
    x402ByAddress.set(addr, arr);
  }

  const allHosts = new Set<string>([
    ...bazaarByHost.keys(),
    ...agenticByHost.keys(),
    ...payshByHost.keys(),
    ...mppDirByHost.keys(),
    ...mppscanByHost.keys(),
    ...framesByHost.keys(),
  ]);

  // Alias rollup: walk the prefix chain looking for the first ancestor
  // that's also in the dataset. Skip-through unknown intermediates so
  // `x402.api.foo.com + foo.com` rolls up to `foo.com` even when no source
  // happens to know `api.foo.com`. Avoids inventing parent rows (we only
  // ever roll up onto a host that already exists somewhere).
  const aliasOf = new Map<string, string>();
  for (const host of [...allHosts]) {
    let cur = aliasCandidate(host);
    while (cur) {
      if (allHosts.has(cur)) {
        aliasOf.set(host, cur);
        break;
      }
      cur = aliasCandidate(cur);
    }
  }

  // Re-route alias hosts onto their canonical host.
  for (const [from, to] of aliasOf) {
    if (bazaarByHost.has(from)) {
      const src = bazaarByHost.get(from)!;
      const tgt = bazaarByHost.get(to);
      if (!tgt) {
        bazaarByHost.set(to, src);
      } else {
        tgt.bazaar_resource_count += src.bazaar_resource_count;
        tgt.total_calls_30d += src.total_calls_30d;
        tgt.networks = [...new Set([...tgt.networks, ...src.networks])];
        tgt.x402_versions = [...new Set([...tgt.x402_versions, ...src.x402_versions])];
        if (
          src.bazaar_last_updated &&
          (!tgt.bazaar_last_updated || src.bazaar_last_updated > tgt.bazaar_last_updated)
        )
          tgt.bazaar_last_updated = src.bazaar_last_updated;
        tgt.amounts_usd.push(...src.amounts_usd);
        tgt.pay_to = [...new Set([...tgt.pay_to, ...src.pay_to])];
      }
    }
    if (agenticByHost.has(from) && !agenticByHost.has(to))
      agenticByHost.set(to, agenticByHost.get(from)!);
    if (payshByHost.has(from) && !payshByHost.has(to))
      payshByHost.set(to, payshByHost.get(from)!);
    if (mppDirByHost.has(from) && !mppDirByHost.has(to))
      mppDirByHost.set(to, mppDirByHost.get(from)!);
    if (mppscanByHost.has(from) && !mppscanByHost.has(to))
      mppscanByHost.set(to, mppscanByHost.get(from)!);
    if (framesByHost.has(from) && !framesByHost.has(to))
      framesByHost.set(to, framesByHost.get(from)!);
    allHosts.delete(from);
  }

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const observedAt = new Date().toISOString();

  const merged: MerchantEntity[] = [];
  for (const host of allHosts) {
    if (!canonicalHost(host)) continue;
    const b = bazaarByHost.get(host);
    const a = agenticByHost.get(host);
    const p = payshByHost.get(host);
    const md = mppDirByHost.get(host);
    const mp = mppscanByHost.get(host);
    const fr = framesByHost.get(host);
    const pr = probeByHost.get(host);

    // Networks: union of raw values, then dedupe by friendly name (so `base`
    // v1 alias + `eip155:8453` count as one chain).
    const rawNetworks = new Set<string>([
      ...(b?.networks ?? []),
      ...(a?.networks ?? []),
      ...(md?.networks ?? []),
    ]);
    const dedupedChains = new Map<string, { name: string; tier: string }>();
    for (const info of [...rawNetworks].map(describeNetwork)) {
      if (!info.mainnet) continue;
      if (!dedupedChains.has(info.name))
        dedupedChains.set(info.name, { name: info.name, tier: info.tier });
    }
    // mppscan confirms Tempo via on-chain settlement evidence.
    if (mp && !dedupedChains.has("Tempo")) {
      dedupedChains.set("Tempo", { name: "Tempo", tier: "alt_l1" });
    }
    // probe advertised_networks: merchant told us in its own 402.
    if (pr) {
      const existingLc = new Set([...dedupedChains.keys()].map((k) => k.toLowerCase()));
      for (const rawN of pr.advertised_networks) {
        const norm = describeNetwork(rawN.toLowerCase());
        const friendly = norm.name === rawN.toLowerCase() ? rawN : norm.name;
        if (existingLc.has(friendly.toLowerCase())) continue;
        const tier =
          friendly.toLowerCase() === "stripe" || friendly.toLowerCase() === "card"
            ? "off_chain"
            : norm.tier;
        dedupedChains.set(friendly, { name: friendly, tier });
        existingLc.add(friendly.toLowerCase());
      }
    }
    const friendlyNames = [...dedupedChains.keys()].sort();
    const tiers = new Set([...dedupedChains.values()].map((c) => c.tier));
    const primaryNetwork = friendlyNames[0] ?? "—";
    const networkCount = dedupedChains.size;

    // Category — strict priority chain.
    let category = "other";
    let categorySource: MerchantEntity["category_source"] = "none";
    if (p?.category && PAYSH_TAXONOMY.has(p.category)) {
      category = p.category;
      categorySource = "pay_sh";
    } else if (fr?.tags?.length) {
      // Frames registry tags often map cleanly onto our taxonomy.
      const tag = fr.tags
        .map((t) => t.toLowerCase())
        .find((t) => PAYSH_TAXONOMY.has(t));
      if (tag) {
        category = tag;
        categorySource = "frames_registry";
      }
    }
    if (categorySource === "none") {
      const fromAgentic = normalizeAgenticCategory(a?.category ?? null);
      if (fromAgentic && fromAgentic !== "other") {
        category = fromAgentic;
        categorySource = "agentic_market";
      } else if (overrides[host]) {
        category = overrides[host].category;
        categorySource = "claude_inferred";
      }
    }

    // Prices: widest min/max across sources we trust.
    const mins = [a?.min_price_usd, p?.min_price_usd, md?.min_price_usd, fr?.min_price_usd]
      .filter((x): x is number => typeof x === "number");
    const maxs = [a?.max_price_usd, p?.max_price_usd, md?.max_price_usd, fr?.max_price_usd]
      .filter((x): x is number => typeof x === "number");
    const minPrice = mins.length ? Math.min(...mins) : null;
    const maxPrice = maxs.length ? Math.max(...maxs) : null;

    // Cross-catalog presence
    const onBazaar = !!b;
    const onAgentic = !!a;
    const onPaysh = !!p;
    const onMppDir = !!md;
    const onMppscan = !!mp;
    const onFrames = !!fr;
    const listedOn =
      (onBazaar ? 1 : 0) +
      (onAgentic ? 1 : 0) +
      (onPaysh ? 1 : 0) +
      (onMppDir ? 1 : 0) +
      (onMppscan ? 1 : 0) +
      (onFrames ? 1 : 0);

    // MPP signal fusion: mppscan = lagging on-chain, probe = leading 402-advertised.
    const probeMethods = (pr?.advertised_methods ?? []).map((m) => m.toLowerCase());
    const advertisesMpp = probeMethods.includes("mpp") || probeMethods.includes("tempo");
    const advertisesX402 = probeMethods.includes("x402");
    const advertisesSiwx = probeMethods.includes("siwx") || (pr?.siwx_resource_count ?? 0) > 0;
    const mppSource: MerchantEntity["mpp_source"] =
      onMppscan && advertisesMpp ? "both" : onMppscan ? "mppscan" : advertisesMpp ? "probe" : "none";

    // Activity flags
    const resourceCount = b?.bazaar_resource_count ?? 0;
    const isMassLister = resourceCount > 500;
    const isActive = !!(b?.bazaar_last_updated && b.bazaar_last_updated > fourteenDaysAgo);
    const isInfra = isInfraHost(host);

    // x402scan join via bazaar pay_to
    let volumeBase = 0;
    let volumeSolana = 0;
    let txCountBase = 0;
    let txCountSolana = 0;
    let x402Buyers = 0;
    const x402Facilitators = new Set<string>();
    let x402SourceUrl: string | undefined;
    for (const addr of b?.pay_to ?? []) {
      const lc = addr.toLowerCase();
      const records = [
        ...(x402ByAddress.get(lc) ?? []),
        ...(lc !== addr ? (x402ByAddress.get(addr) ?? []) : []),
      ];
      for (const r of records) {
        if (r.chain === "base") {
          volumeBase += r.volume_usd_30d;
          txCountBase += r.tx_count;
        } else if (r.chain === "solana") {
          volumeSolana += r.volume_usd_30d;
          txCountSolana += r.tx_count;
        }
        x402Buyers += r.unique_buyers;
        for (const f of r.facilitator_ids) x402Facilitators.add(f);
        if (!x402SourceUrl) x402SourceUrl = r.source_url;
      }
    }

    const displayName = pickDisplayName(
      host,
      a?.display_name,
      p?.display_name,
      fr?.display_name,
      md?.display_name,
      mp?.display_name,
    );
    const hasCuratedName =
      (a?.display_name && a.display_name.toLowerCase() !== host) ||
      (p?.display_name && p.display_name.toLowerCase() !== host) ||
      (fr?.display_name && fr.display_name.toLowerCase() !== host) ||
      (md?.display_name && md.display_name.toLowerCase() !== host) ||
      (mp?.display_name && mp.display_name.toLowerCase() !== host);
    const isRecognized = !!hasCuratedName && !isInfra && !isMassLister;

    // Endpoint counts: prefer the richest source. frames-registry has paid/siwx
    // breakdown via OpenAPI; mpp-directory has paid_endpoint_count; bazaar has
    // total resource_count (paid by definition).
    const endpointCount = Math.max(
      b?.bazaar_resource_count ?? 0,
      md?.endpoint_count ?? 0,
      a?.endpoint_count ?? 0,
      p?.endpoint_count ?? 0,
      (fr?.paid_endpoint_count ?? 0) + (fr?.siwx_endpoint_count ?? 0) + (fr?.free_endpoint_count ?? 0),
    );
    const paidEndpointCount = Math.max(
      b?.bazaar_resource_count ?? 0,
      md?.paid_endpoint_count ?? 0,
      fr?.paid_endpoint_count ?? 0,
    );

    merged.push({
      host,
      display_name: displayName,
      description: pickFirst(
        a?.description,
        fr?.description,
        p?.description,
        md?.description,
        mp?.description,
        b?.description,
      ),
      category,
      category_source: categorySource,
      x_guidance: fr?.x_guidance ?? pr?.x_guidance ?? null,

      networks_accepted: [...rawNetworks].sort().join(","),
      network_names: friendlyNames.join(", "),
      primary_network: primaryNetwork,
      network_count: networkCount,
      network_tiers: [...tiers].sort().join(","),

      on_bazaar: onBazaar,
      on_agentic_market: onAgentic,
      on_pay_sh: onPaysh,
      on_mpp_directory: onMppDir,
      on_mppscan: onMppscan,
      on_frames_registry: onFrames,
      listed_on_count: listedOn,

      advertises_mpp: advertisesMpp,
      advertises_x402: advertisesX402,
      advertises_siwx: advertisesSiwx,
      advertised_methods: (pr?.advertised_methods ?? []).join(", "),
      advertised_networks: (pr?.advertised_networks ?? []).join(", "),
      probe_status: pr?.probe_status ?? "untried",
      has_openapi: !!pr?.has_openapi || !!fr,
      per_route_schemas: pr?.per_route_schemas ?? 0,
      mpp_source: mppSource,

      bazaar_resource_count: resourceCount,
      bazaar_last_updated: b?.bazaar_last_updated ?? null,
      total_calls_30d: b?.total_calls_30d ?? 0,
      tempo_tx_count: mp?.tempo_tx_count ?? 0,
      tempo_volume_usd: mp?.tempo_volume_usd ?? 0,
      tempo_latest_tx: mp?.tempo_latest_tx ?? null,
      volume_usd_base: volumeBase,
      volume_usd_solana: volumeSolana,
      tx_count_base: txCountBase,
      tx_count_solana: txCountSolana,
      x402_tx_count_30d: txCountBase + txCountSolana,
      x402_volume_usd_30d: volumeBase + volumeSolana,
      x402_buyers_30d: x402Buyers,
      x402_facilitators: [...x402Facilitators].sort().join(", "),

      is_active_14d: isActive,
      is_mass_lister: isMassLister,
      is_infra: isInfra,
      is_recognized: isRecognized,

      min_price_usd: minPrice,
      max_price_usd: maxPrice,

      endpoint_count: endpointCount,
      paid_endpoint_count: paidEndpointCount,
      siwx_endpoint_count: fr?.siwx_endpoint_count ?? pr?.siwx_resource_count ?? 0,

      observed_at: observedAt,
      evidence: {
        bazaar: b?.source_url,
        agentic_market: a?.source_url,
        paysh: p?.source_url,
        mpp_directory: md?.source_url,
        mppscan: mp?.source_url,
        x402scan: x402SourceUrl,
        frames_registry: fr?.source_url,
        probe: pr?.probe_origin,
      },
    });
  }

  // Sort: recognized + active first, then by 30d volume, then resource count.
  merged.sort((a, b) => {
    const aBad = (a.is_mass_lister ? 1 : 0) + (a.is_infra ? 1 : 0);
    const bBad = (b.is_mass_lister ? 1 : 0) + (b.is_infra ? 1 : 0);
    if (aBad !== bBad) return aBad - bBad;
    const aGood = (a.is_recognized ? 2 : 0) + (a.is_active_14d ? 1 : 0);
    const bGood = (b.is_recognized ? 2 : 0) + (b.is_active_14d ? 1 : 0);
    if (aGood !== bGood) return bGood - aGood;
    if (a.x402_volume_usd_30d !== b.x402_volume_usd_30d)
      return b.x402_volume_usd_30d - a.x402_volume_usd_30d;
    return b.bazaar_resource_count - a.bazaar_resource_count;
  });

  return merged;
}

function main() {
  const inputs: MergeInputs = {
    bazaar: loadJsonOrEmpty<BazaarMerchant>("staging/bazaar-merchants.json"),
    agentic: loadJsonOrEmpty<AgenticMerchant>("staging/agentic-market.json"),
    paysh: loadJsonOrEmpty<PayshMerchant>("staging/paysh.json"),
    mppDir: loadJsonOrEmpty<MppDirectoryMerchant>("staging/mpp-directory-merchants.json"),
    mppscan: loadJsonOrEmpty<MppscanMerchant>("staging/mppscan.json"),
    x402scan: loadJsonOrEmpty<X402scanRecord>("staging/x402scan.json"),
    frames: loadJsonOrEmpty<FramesRegistryMerchant>("staging/frames-registry-merchants.json"),
    probe: loadJsonOrEmpty<ProbeRow>("staging/probe-results.json"),
    overrides: loadOverrides(),
  };

  const merged = mergeMerchants(inputs);

  mkdirSync("staging", { recursive: true });
  writeFileSync("staging/merchants.json", JSON.stringify(merged, null, 2));

  const active = merged.filter((m) => m.is_active_14d).length;
  const massListers = merged.filter((m) => m.is_mass_lister).length;
  const multiRail = merged.filter((m) => m.network_count >= 2).length;
  const infra = merged.filter((m) => m.is_infra).length;
  const recognized = merged.filter((m) => m.is_recognized).length;
  const probedOk = merged.filter((m) => m.probe_status === "ok").length;
  const advMpp = merged.filter((m) => m.advertises_mpp).length;
  const withGuidance = merged.filter((m) => m.x_guidance).length;
  console.error(`✓ merged ${merged.length} merchants → staging/merchants.json`);
  console.error(
    `   active=${active}  recognized=${recognized}  multi-rail=${multiRail}  mass=${massListers}  infra=${infra}`,
  );
  console.error(
    `   probed_ok=${probedOk}  advertises_mpp=${advMpp}  x_guidance=${withGuidance}`,
  );
}

// Only auto-run when invoked directly, not when imported by tests.
if (import.meta.main) main();
