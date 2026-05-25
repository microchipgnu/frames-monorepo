#!/usr/bin/env bun
// One-off backfill: rewrite each content/tools/frames.*.json descriptor's
// `payment.network` + `payment.accepts[]` using the multi-rail data from
// staging/frames-registry-services.json (which now includes each service's
// `/offer` manifest).
//
// Lifecycle: needed once after scrape-frames-registry.ts started capturing
// `endpoints.offer` and write-projections.ts started consuming it. The
// next regular `bun run project` will produce the same output via the
// canonical path-of-record. After that happens at least once, this script
// can be deleted.
//
// Conservative on purpose: only touches content/tools/frames.*.json — never
// adds new descriptors, never deletes them. After running, the slim index
// still needs `bun scripts/backfill-accepts-networks.ts` to surface the
// fresh accepts_networks values.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FramesServiceWithSpec, FramesOffer, FramesOfferRoute } from "./scrape-frames-registry.ts";
import type { ToolDescriptor } from "../server/src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STAGING = resolve(ROOT, "staging/frames-registry-services.json");
const TOOLS = resolve(ROOT, "content/tools");

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
    return "solana-mainnet";
  }
  return undefined;
}

function priceHintFromOffer(price?: string): string | undefined {
  if (!price) return undefined;
  const stripped = price.replace(/^\$/, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

interface ComputedPayment {
  network: string;
  accepts?: Array<{ protocol: string; network: string; currency: string; price_hint?: string }>;
  price_hint?: string;
}

function offerRouteToDescriptorId(serviceSlug: string, route: string): string | null {
  // Offer route: "POST /api/search". Mirror framesToDescriptors's id rule.
  const m = route.match(/^([A-Z]+)\s+(.+)$/);
  if (!m) return null;
  const [, method, path] = m;
  return `frames.${slugify(serviceSlug)}.${method!.toLowerCase()}.${slugify(path!)}`;
}

function computePaymentFromOfferRoute(route: FramesOfferRoute): ComputedPayment | null {
  const offerNetworks = (route.networks ?? [])
    .map((n) => canonicalNetworkName(n.network))
    .filter((x): x is string => typeof x === "string");
  const unique = Array.from(new Set(offerNetworks));
  if (unique.length === 0) return null;
  const [primary, ...rest] = unique;
  const priceHint = priceHintFromOffer(route.price);
  return {
    network: primary!,
    ...(priceHint && { price_hint: priceHint }),
    ...(rest.length > 0 && {
      accepts: rest.map((network) => ({
        protocol: "x402v2",
        network,
        currency: "USDC",
        ...(priceHint && { price_hint: priceHint }),
      })),
    }),
  };
}

function main() {
  if (!existsSync(STAGING)) {
    console.error(`missing ${STAGING} — run \`bun run scrape:frames-registry\` first`);
    process.exit(1);
  }
  const bundles = JSON.parse(readFileSync(STAGING, "utf-8")) as FramesServiceWithSpec[];

  // Map descriptor id → computed multi-rail payment.
  const payments = new Map<string, ComputedPayment>();
  for (const bundle of bundles) {
    const offer: FramesOffer | null = bundle.offer ?? null;
    if (!offer?.tools) continue;
    for (const route of offer.tools) {
      const id = offerRouteToDescriptorId(bundle.service.slug, route.route);
      if (!id) continue;
      const payment = computePaymentFromOfferRoute(route);
      if (payment) payments.set(id, payment);
    }
  }
  console.error(`computed multi-rail payment for ${payments.size} frames.* descriptors`);

  let updated = 0;
  let unchanged = 0;
  let missing = 0;
  for (const file of readdirSync(TOOLS)) {
    if (!file.startsWith("frames.")) continue;
    const id = file.replace(/\.json$/, "");
    const filePath = resolve(TOOLS, file);
    const desc = JSON.parse(readFileSync(filePath, "utf-8")) as ToolDescriptor;
    const next = payments.get(id);
    if (!next) {
      // Descriptor exists but offer didn't mention this route — leave it alone.
      missing++;
      continue;
    }
    // Preserve every existing field; only rewrite the rail-related ones.
    const before = JSON.stringify(desc.payment);
    desc.payment = {
      ...desc.payment,
      network: next.network,
      ...(next.price_hint && { price_hint: next.price_hint }),
      ...(next.accepts !== undefined ? { accepts: next.accepts } : {}),
    };
    // Drop accepts if newly-empty (no alternates).
    if (next.accepts === undefined && "accepts" in desc.payment) {
      delete (desc.payment as { accepts?: unknown }).accepts;
    }
    const after = JSON.stringify(desc.payment);
    if (after === before) {
      unchanged++;
      continue;
    }
    writeFileSync(filePath, JSON.stringify(desc, null, 2) + "\n");
    updated++;
  }

  console.error(
    `frames.*: updated=${updated}  unchanged=${unchanged}  no_offer=${missing}`,
  );
  console.error(
    `next: run \`bun scripts/backfill-accepts-networks.ts\` to re-stamp the slim index`,
  );
}

main();
