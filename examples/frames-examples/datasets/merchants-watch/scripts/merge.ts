#!/usr/bin/env bun
// Merge the three staging files into one merged.json keyed by host.
// Rules:
//   - canonical key is `host` (already normalized in scrapers)
//   - networks_accepted = union across all sources (raw strings + tier labels)
//   - display_name priority: agentic.market > pay.sh > bazaar.description first words > host
//   - description priority: agentic.market > pay.sh > bazaar
//   - category priority: pay.sh > agentic.market explicit > "other" (no Claude classify in v1)
//   - listed_on_count = 1..3 based on presence in each source
//   - is_active_14d = bazaar_last_updated within 14 days
//   - is_mass_lister = bazaar_resource_count > 500
//   - prices: take widest min/max across sources

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Frame } from "@frames-ag/frame";
import { describeNetwork, isInfraHost } from "./host.ts";
import { entityIdFromHost } from "./host.ts";

// Static, hand-curated category map for hosts that neither pay.sh nor
// agentic.market categorize. Reviewed by humans (or via in-chat Claude
// classification); checked into git so it's auditable. Falls back to
// "other" for unknown hosts.
const OVERRIDES_PATH = "category-overrides.json";
type CategoryOverride = { category: string; reason?: string };
const overrides: Record<string, CategoryOverride> = existsSync(OVERRIDES_PATH)
  ? JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"))
  : {};

type Bazaar = {
  host: string;
  bazaar_resource_count: number;
  networks: string[];
  x402_versions: number[];
  bazaar_last_updated: string | null;
  description: string | null;
  sample_resources: { url: string; lastUpdated?: string }[];
  amounts_usd: number[];
  source_url: string;
  observed_at: string;
};
type Agentic = {
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
type Paysh = {
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
type Mppscan = {
  host: string;
  display_name: string | null;
  description: string | null;
  tempo_tx_count: number;
  tempo_volume_usd: number;
  tempo_buyers: number;
  tempo_latest_tx: string | null;
  mpp_resource_count: number;
  rank: number | null;
  source_url: string;
  observed_at: string;
};
type X402scan = {
  recipient: string; // lowercased address
  chain: "base" | "solana";
  facilitator_ids: string[];
  tx_count: number;
  volume_usd_30d: number;
  unique_buyers: number;
  source_url: string;
  observed_at: string;
};
type Probe = {
  host: string;
  probe_endpoint: string | null;
  probe_status: "ok" | "non-402" | "timeout" | "error" | "skipped";
  http_status: number | null;
  advertises_x402: boolean;
  advertises_mpp: boolean;
  advertised_methods: string[];
  advertised_networks: string[];
  advertised_recipients: string[];
  protocol_signals: string[];
  sibling_of: string | null;
  observed_at: string;
};

type Merged = {
  host: string;
  display_name: string;
  description: string | null;
  category: string;
  category_source: "pay_sh" | "agentic_market" | "claude_inferred" | "none";

  networks_accepted: string;
  network_names: string;
  primary_network: string;
  network_count: number;
  network_tiers: string;

  on_bazaar: boolean;
  on_agentic_market: boolean;
  on_pay_sh: boolean;
  on_mppscan: boolean;
  // Direct-probe MPP advertising signals — see probe-402.ts.
  advertises_mpp: boolean;
  advertises_x402: boolean;
  advertised_methods: string;
  advertised_networks: string;
  mpp_source: "none" | "mppscan" | "probe" | "both";
  probe_status: "ok" | "non-402" | "timeout" | "error" | "skipped" | "untried";
  probe_endpoint: string | null;
  listed_on_count: number;

  bazaar_resource_count: number;
  bazaar_last_updated: string | null;
  tempo_tx_count: number;
  tempo_volume_usd: number;
  tempo_latest_tx: string | null;
  // Per-chain x402 volume (30d, USDC). Split so we can quote the gap per
  // chain — e.g. "moltycash made $X on Base, $Y on Solana, $Z on Tempo."
  volume_usd_base: number;
  volume_usd_solana: number;
  tx_count_base: number;
  tx_count_solana: number;
  x402_tx_count_30d: number;
  x402_volume_usd_30d: number;
  x402_buyers_30d: number;
  x402_facilitators: string;
  is_active_14d: boolean;
  is_mass_lister: boolean;
  is_infra: boolean;
  is_recognized: boolean;

  min_price_usd: number | null;
  max_price_usd: number | null;

  observed_at: string;
  evidence: {
    bazaar?: string;
    agentic_market?: string;
    paysh?: string;
    mppscan?: string;
    x402scan?: string;
  };
};

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
  // Map agentic.market's TitleCase categories onto pay.sh's snake_case taxonomy.
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

function pickDisplayName(host: string, ...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  // Fallback: derive from host
  return host.replace(/^(api|x402|www)\./, "").replace(/^./, (s) => s.toUpperCase());
}

// Read previously-evidenced display_name / description / category off the
// frame. These fields can be set by the curate (agent) pass — when scrapers
// have nothing fresh to say, we want those evidenced values to survive the
// merge instead of getting clobbered back to the host-derived fallback.
//
// Scrapers still win when they DO provide a value: pay.sh / agentic.market
// are higher-authority than agent inference for category, and curated brand
// names from the indexes still take precedence over agent-written ones.
type FrameOverride = {
  display_name?: string;
  description?: string;
  category?: string;
  category_source?: string;
  is_recognized?: boolean;
};

function loadFrameOverrides(framePath: string): Map<string, FrameOverride> {
  const out = new Map<string, FrameOverride>();
  try {
    const frame = new Frame(framePath, { agent: "system:merchants-watch-merge" });
    const result = frame.query({ mode: "all" });
    for (const row of result.rows) {
      const f = row.fields as Record<string, unknown>;
      const host = typeof f.host === "string" ? f.host : null;
      if (!host) continue;
      const o: FrameOverride = {};
      if (typeof f.display_name === "string") o.display_name = f.display_name;
      if (typeof f.description === "string") o.description = f.description;
      if (typeof f.category === "string") o.category = f.category;
      if (typeof f.category_source === "string") o.category_source = f.category_source;
      if (typeof f.is_recognized === "boolean") o.is_recognized = f.is_recognized;
      out.set(host, o);
    }
  } catch {
    /* no events yet — first run, nothing to preserve */
  }
  return out;
}

function main() {
  const bazaar: Bazaar[] = JSON.parse(readFileSync("staging/bazaar.json", "utf8"));
  const agentic: Agentic[] = JSON.parse(readFileSync("staging/agentic-market.json", "utf8"));
  const paysh: Paysh[] = JSON.parse(readFileSync("staging/paysh.json", "utf8"));
  const mppscan: Mppscan[] = existsSync("staging/mppscan.json")
    ? JSON.parse(readFileSync("staging/mppscan.json", "utf8"))
    : [];
  const x402scan: X402scan[] = existsSync("staging/x402scan.json")
    ? JSON.parse(readFileSync("staging/x402scan.json", "utf8"))
    : [];
  const probe: Probe[] = existsSync("staging/probe-results.json")
    ? JSON.parse(readFileSync("staging/probe-results.json", "utf8"))
    : [];

  // Snapshot frame-evidenced overrides ONCE so the per-host loop is fast.
  const frameByHost = loadFrameOverrides(process.cwd());

  const bazaarByHost = new Map(bazaar.map((b) => [b.host, b]));
  const agenticByHost = new Map(agentic.map((a) => [a.host, a]));
  const payshByHost = new Map(paysh.map((p) => [p.host, p]));
  const mppscanByHost = new Map(mppscan.map((m) => [m.host, m]));
  // Probe is keyed by the probed host, but probed siblings (mpp.foo.com) need
  // to credit the seed host (foo.com) too. We index by both.
  const probeByHost = new Map<string, Probe>();
  for (const p of probe) {
    probeByHost.set(p.host, p);
    if (p.sibling_of && p.probe_status === "ok") {
      // Only credit the seed host if the sibling found a real 402 — we don't
      // want a guessed sibling that 404'd to overwrite the seed's own probe.
      const existing = probeByHost.get(p.sibling_of);
      if (!existing || existing.probe_status !== "ok") {
        probeByHost.set(p.sibling_of, { ...p, host: p.sibling_of });
      } else if (p.advertises_mpp && !existing.advertises_mpp) {
        // Sibling-host has stronger MPP signal — merge methods/networks into
        // the seed entry while keeping the seed's probe_endpoint reference.
        probeByHost.set(p.sibling_of, {
          ...existing,
          advertises_mpp: true,
          advertises_x402: existing.advertises_x402 || p.advertises_x402,
          advertised_methods: [
            ...new Set([...existing.advertised_methods, ...p.advertised_methods]),
          ].sort(),
          advertised_networks: [
            ...new Set([...existing.advertised_networks, ...p.advertised_networks]),
          ].sort(),
        });
      }
    }
  }

  // x402scan keys by recipient ADDRESS, not host. Join via bazaar's pay_to set.
  // Some merchants advertise the same address across chains; we sum across all
  // their address records that hit `chain in {base, solana}`.
  const x402ByAddress = new Map<string, X402scan[]>();
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
    ...mppscanByHost.keys(),
    // Sibling-only hosts (mpp.browserbase.com when the bazaar only knows
    // x402.browserbase.com) need to roll up onto a parent — they get folded
    // by the alias logic below. But seed hosts whose probe was successful
    // are already in bazaarByHost so we don't add probeByHost keys here.
  ]);

  // Also try matching pay.sh hosts back to agentic.market hosts via prefix strip
  // (api.exa.ai → exa.ai, x402.api.foo.to → foo.to). We register the alias so
  // the merged entity reflects shared identity.
  const aliasOf = new Map<string, string>();
  for (const host of [...allHosts]) {
    const bare = host
      .replace(/^x402\.api\./, "")
      .replace(/^x402\./, "")
      .replace(/^api\./, "");
    if (bare !== host && allHosts.has(bare)) {
      aliasOf.set(host, bare);
    }
  }

  // Re-route entries from alias hosts onto their canonical host.
  for (const [from, to] of aliasOf) {
    if (bazaarByHost.has(from) && !bazaarByHost.has(to)) {
      bazaarByHost.set(to, bazaarByHost.get(from)!);
    } else if (bazaarByHost.has(from) && bazaarByHost.has(to)) {
      // Merge resource counts when both exist.
      const a = bazaarByHost.get(to)!;
      const b = bazaarByHost.get(from)!;
      a.bazaar_resource_count += b.bazaar_resource_count;
      a.networks = [...new Set([...a.networks, ...b.networks])];
      a.x402_versions = [...new Set([...a.x402_versions, ...b.x402_versions])];
      if (b.bazaar_last_updated && (!a.bazaar_last_updated || b.bazaar_last_updated > a.bazaar_last_updated))
        a.bazaar_last_updated = b.bazaar_last_updated;
      a.amounts_usd.push(...b.amounts_usd);
    }
    if (agenticByHost.has(from) && !agenticByHost.has(to)) {
      agenticByHost.set(to, agenticByHost.get(from)!);
    }
    if (payshByHost.has(from) && !payshByHost.has(to)) {
      payshByHost.set(to, payshByHost.get(from)!);
    }
    allHosts.delete(from);
  }

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const observedAt = new Date().toISOString();

  const merged: Merged[] = [];
  for (const host of allHosts) {
    const b = bazaarByHost.get(host);
    const a = agenticByHost.get(host);
    const p = payshByHost.get(host);
    const mp = mppscanByHost.get(host);
    const pr = probeByHost.get(host);

    // Networks union — both Bazaar (CAIP-2 + v1 aliases) and agentic.market
    // (Title-case names). Raw strings stay raw for the networks_accepted
    // column (audit trail), but we de-duplicate by FRIENDLY name for
    // network_count / network_names / tiers — otherwise a merchant who
    // advertises both `base` (v1) AND `eip155:8453` (v2) is counted as
    // 2 networks instead of 1.
    const rawNetworks = new Set<string>([
      ...(b?.networks ?? []),
      ...(a?.networks ?? []),
    ]);
    const dedupedChains = new Map<
      string,
      { name: string; tier: string }
    >();
    for (const info of [...rawNetworks].map(describeNetwork)) {
      if (!info.mainnet) continue;
      if (!dedupedChains.has(info.name)) {
        dedupedChains.set(info.name, { name: info.name, tier: info.tier });
      }
    }
    // mppscan tells us a merchant accepts Tempo via MPP. That's authoritative
    // for Tempo coverage — much more reliable than the bazaar's x402-only view
    // (the bazaar only sees x402 settlements on eip155:4217; MPP-on-Tempo
    // doesn't go through the CDP Facilitator that powers the bazaar).
    if (mp && !dedupedChains.has("Tempo")) {
      dedupedChains.set("Tempo", { name: "Tempo", tier: "alt_l1" });
    }
    // probe-402 advertised_networks: merchant TOLD us in its 402 challenge.
    // Add any chain the probe found that we haven't already counted. This is
    // how Browserbase's Tempo support gets credited even though mppscan
    // hasn't indexed a Browserbase settlement yet.
    if (pr) {
      // Case-insensitive dedup: probe results may contain both "Tempo" (from
      // chainId 4217 lookup) and "tempo" (from raw method string) — same chain.
      const existingLc = new Set(
        [...dedupedChains.keys()].map((k) => k.toLowerCase()),
      );
      for (const rawN of pr.advertised_networks) {
        // Normalize through describeNetwork so we converge "tempo" → "Tempo".
        const friendly = describeNetwork(rawN.toLowerCase()).name === rawN.toLowerCase()
          ? rawN // unknown, keep as-is
          : describeNetwork(rawN.toLowerCase()).name;
        if (existingLc.has(friendly.toLowerCase())) continue;
        const tier =
          friendly.toLowerCase() === "stripe" || friendly.toLowerCase() === "card"
            ? "off_chain"
            : describeNetwork(rawN.toLowerCase()).tier;
        dedupedChains.set(friendly, { name: friendly, tier });
        existingLc.add(friendly.toLowerCase());
      }
    }
    const friendlyNames = [...dedupedChains.keys()].sort();
    const tiers = new Set([...dedupedChains.values()].map((c) => c.tier));
    const primaryNetwork = friendlyNames[0] ?? "—";
    const networkCount = dedupedChains.size;

    // Category: pay.sh > agentic > category-overrides.json > frame-evidenced
    // agent inference > "other". Agent-written inferences (category_source =
    // "claude_inferred") survive across ticks until a higher-authority source
    // (pay.sh or agentic.market) catalogs the host.
    let category = "other";
    let categorySource: "pay_sh" | "agentic_market" | "claude_inferred" | "none" = "none";
    if (p?.category && PAYSH_TAXONOMY.has(p.category)) {
      category = p.category;
      categorySource = "pay_sh";
    } else {
      const fromAgentic = normalizeAgenticCategory(a?.category ?? null);
      if (fromAgentic && fromAgentic !== "other") {
        category = fromAgentic;
        categorySource = "agentic_market";
      } else if (overrides[host]) {
        category = overrides[host].category;
        categorySource = "claude_inferred";
      } else {
        const fromFrame = frameByHost.get(host);
        if (
          fromFrame?.category &&
          fromFrame.category !== "other" &&
          fromFrame.category_source === "claude_inferred"
        ) {
          category = fromFrame.category;
          categorySource = "claude_inferred";
        }
      }
    }

    // Prices: widest min/max across sources we trust
    const mins = [a?.min_price_usd, p?.min_price_usd].filter((x): x is number => typeof x === "number");
    const maxs = [a?.max_price_usd, p?.max_price_usd].filter((x): x is number => typeof x === "number");
    const minPrice = mins.length ? Math.min(...mins) : null;
    const maxPrice = maxs.length ? Math.max(...maxs) : null;

    const onBazaar = !!b;
    const onAgentic = !!a;
    const onPaysh = !!p;
    const onMppscan = !!mp;
    const listedOn =
      (onBazaar ? 1 : 0) +
      (onAgentic ? 1 : 0) +
      (onPaysh ? 1 : 0) +
      (onMppscan ? 1 : 0);

    // MPP signal fusion. Two sources can each independently confirm it:
    //   - mppscan: settlement-indexed (lagging — only catches merchants who
    //     have actually received MPP payments)
    //   - probe:   advertisement-indexed (leading — catches merchants who
    //     advertise the rail before any payment lands)
    // mpp_source tracks which fired so the publisher can show provenance.
    const probeMpp = !!pr?.advertises_mpp;
    const probeX402 = !!pr?.advertises_x402;
    const advertisesMpp = probeMpp;
    const advertisesX402 = probeX402;
    const mppSource: "none" | "mppscan" | "probe" | "both" =
      onMppscan && advertisesMpp
        ? "both"
        : onMppscan
          ? "mppscan"
          : advertisesMpp
            ? "probe"
            : "none";

    const resourceCount = b?.bazaar_resource_count ?? 0;
    const isMassLister = resourceCount > 500;
    const isActive = !!(b?.bazaar_last_updated && b.bazaar_last_updated > fourteenDaysAgo);
    const isInfra = isInfraHost(host);

    // x402scan join — for each of this merchant's pay_to addresses, accumulate
    // per-chain tx_count + volume + buyers. Solana addresses are case-sensitive
    // so we look them up both lowercased (for EVM addrs already lowered by
    // bazaar) and raw.
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
        ...(lc !== addr ? x402ByAddress.get(addr) ?? [] : []),
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
    const x402TxCount = txCountBase + txCountSolana;
    const x402Volume = volumeBase + volumeSolana;

    const fromFrame = frameByHost.get(host);
    const displayName = pickDisplayName(
      host,
      a?.display_name,
      p?.display_name,
      mp?.display_name,
      // Agent-evidenced fallback: only used when no scraper found a curated
      // name. Excluded if it matches the host fallback (means a prior merge
      // already wrote the host-derived value with no real curation).
      fromFrame?.display_name &&
        fromFrame.display_name.toLowerCase() !== host
        ? fromFrame.display_name
        : undefined,
    );
    // "Recognized" = there's a real human-curated brand name (not the host
    // fallback) AND it's not infra. The launchable showcase set. The curate
    // agent's `recognizer` can also evidence a brand by writing display_name,
    // so a frame-evidenced display_name counts when scrapers have nothing.
    const hasCuratedName =
      (a?.display_name && a.display_name.toLowerCase() !== host) ||
      (p?.display_name && p.display_name.toLowerCase() !== host) ||
      (mp?.display_name && mp.display_name.toLowerCase() !== host) ||
      !!(
        fromFrame?.display_name &&
        fromFrame.display_name.toLowerCase() !== host
      );
    const isRecognized = !!hasCuratedName && !isInfra && !isMassLister;

    merged.push({
      host,
      display_name: displayName,
      description:
        a?.description ??
        p?.description ??
        mp?.description ??
        b?.description ??
        fromFrame?.description ??
        null,
      category,
      category_source: categorySource,
      networks_accepted: [...rawNetworks].sort().join(","),
      network_names: friendlyNames.join(", "),
      primary_network: primaryNetwork,
      network_count: networkCount,
      network_tiers: [...tiers].sort().join(","),
      on_bazaar: onBazaar,
      on_agentic_market: onAgentic,
      on_pay_sh: onPaysh,
      on_mppscan: onMppscan,
      advertises_mpp: advertisesMpp,
      advertises_x402: advertisesX402,
      advertised_methods: (pr?.advertised_methods ?? []).join(", "),
      advertised_networks: (pr?.advertised_networks ?? []).join(", "),
      mpp_source: mppSource,
      probe_status: pr?.probe_status ?? "untried",
      probe_endpoint: pr?.probe_endpoint ?? null,
      listed_on_count: listedOn,
      bazaar_resource_count: resourceCount,
      bazaar_last_updated: b?.bazaar_last_updated ?? null,
      tempo_tx_count: mp?.tempo_tx_count ?? 0,
      tempo_volume_usd: mp?.tempo_volume_usd ?? 0,
      tempo_latest_tx: mp?.tempo_latest_tx ?? null,
      volume_usd_base: volumeBase,
      volume_usd_solana: volumeSolana,
      tx_count_base: txCountBase,
      tx_count_solana: txCountSolana,
      x402_tx_count_30d: x402TxCount,
      x402_volume_usd_30d: x402Volume,
      x402_buyers_30d: x402Buyers,
      x402_facilitators: [...x402Facilitators].sort().join(", "),
      is_active_14d: isActive,
      is_mass_lister: isMassLister,
      is_infra: isInfra,
      is_recognized: isRecognized,
      min_price_usd: minPrice,
      max_price_usd: maxPrice,
      observed_at: observedAt,
      evidence: {
        bazaar: b?.source_url,
        agentic_market: a?.source_url,
        paysh: p?.source_url,
        mppscan: mp?.source_url,
        x402scan: x402SourceUrl,
      },
    });
  }

  merged.sort((a, b) => {
    if (a.is_mass_lister !== b.is_mass_lister) return a.is_mass_lister ? 1 : -1;
    return b.bazaar_resource_count - a.bazaar_resource_count;
  });

  writeFileSync("staging/merged.json", JSON.stringify(merged, null, 2));
  console.error(`✓ merged ${merged.length} merchants → staging/merged.json`);

  const active = merged.filter((m) => m.is_active_14d).length;
  const massListers = merged.filter((m) => m.is_mass_lister).length;
  const multiRail = merged.filter((m) => m.network_count >= 2).length;
  const infra = merged.filter((m) => m.is_infra).length;
  const recognized = merged.filter((m) => m.is_recognized).length;
  const overridden = merged.filter((m) => m.category_source === "claude_inferred").length;
  const probedOk = merged.filter((m) => m.probe_status === "ok").length;
  const advMpp = merged.filter((m) => m.advertises_mpp).length;
  const probeOnlyMpp = merged.filter((m) => m.mpp_source === "probe").length;
  console.error(
    `   active=${active}  mass=${massListers}  multi=${multiRail}  infra=${infra}  recognized=${recognized}  override_cats=${overridden}`,
  );
  console.error(
    `   probed_ok=${probedOk}  advertises_mpp=${advMpp}  mpp_via_probe_only=${probeOnlyMpp}`,
  );
}

main();
