#!/usr/bin/env bun
// One-off backfill: rewrite each content/tools/frames.*.json descriptor's
// `payment` block from the live 402 probes captured by
// scripts/probe-402-frames-registry.ts.
//
// Why: /offer publishes only `{network, networkName}` per route — no
// currency, no asset, no permit2/feePayer extras. The live 402 body's
// `accepts[]` array is the ground truth (it's what agentwallet actually
// negotiates against). For exa, /offer claims [Base, Solana]; the 402
// reveals 5 (network, asset) pairs including Solana CASH.
//
// Conservative: never adds/removes descriptors, only rewrites the
// payment block. Routes without a successful probe are left alone.
// Deletable after `bun run project` runs against fresh probe staging.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDescriptor, PaymentOption } from "../server/src/types.ts";
import type {
  RouteProbe,
  X402AcceptsEntry,
} from "./probe-402-frames-registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PROBES_PATH = resolve(ROOT, "staging/frames-registry-402-probes.json");
const TOOLS = resolve(ROOT, "content/tools");

function canonicalNetworkName(caip2: string): string | undefined {
  if (caip2.startsWith("eip155:")) {
    switch (caip2.slice("eip155:".length)) {
      case "1":
        return "ethereum";
      case "8453":
        return "base";
      case "84532":
        return "base-sepolia";
      case "42161":
        return "arbitrum";
      case "10":
        return "optimism";
      case "137":
        return "polygon";
      case "196":
        return "xlayer";
      case "43114":
        return "avalanche";
      default:
        return undefined;
    }
  }
  if (caip2.startsWith("solana:")) {
    const cluster = caip2.slice("solana:".length);
    if (cluster === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") return "solana-mainnet";
    if (cluster === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wwLy85A" || cluster === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1") return "solana-devnet";
    return undefined;
  }
  return undefined;
}

// Per-(network, asset-lowercased) → { currency, decimals }. Used when the
// seller's 402 entry doesn't carry an `extra.name` that disambiguates.
const KNOWN_ASSETS: Record<string, { currency: string; decimals: number }> = {
  // Base
  "eip155:8453|0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { currency: "USDC", decimals: 6 },
  "eip155:8453|0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": { currency: "USDT", decimals: 6 },
  // Base Sepolia
  "eip155:84532|0x036cbd53842c5426634e7929541ec2318f3dcf7e": { currency: "USDC", decimals: 6 },
  // Polygon
  "eip155:137|0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { currency: "USDC", decimals: 6 },
  // X Layer
  "eip155:196|0x74b7f16337b8972027f6196a17a631ac6de26d22": { currency: "USDC", decimals: 6 },
  // Avalanche
  "eip155:43114|0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { currency: "USDC", decimals: 6 },
  // Solana mainnet
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp|epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v": { currency: "USDC", decimals: 6 },
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp|es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb": { currency: "USDT", decimals: 6 },
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp|cashx9kjustyftlfwgvevf59sgeg9sh5ffcnzmvpcash": { currency: "CASH", decimals: 6 },
  // Solana devnet
  "solana:etwtrabzaq6imfeykouru166vu2xqa1|4zmmc9srt5ri5x14gagxhaii3gnpaeerypjgzjdncdu": { currency: "USDC", decimals: 6 },
};

function normalizeNameToCurrency(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const n = name.trim();
  if (/usd\s*coin/i.test(n)) return "USDC";
  if (/tether/i.test(n)) return "USDT";
  if (/^cash$/i.test(n)) return "CASH";
  if (/^usdc$/i.test(n)) return "USDC";
  if (/^usdt$/i.test(n)) return "USDT";
  return undefined;
}

function currencyAndDecimalsFor(entry: X402AcceptsEntry): { currency?: string; decimals: number } {
  const name = (entry.extra && typeof entry.extra === "object" && typeof (entry.extra as { name?: unknown }).name === "string")
    ? (entry.extra as { name: string }).name
    : undefined;
  const fromName = normalizeNameToCurrency(name);
  if (fromName) return { currency: fromName, decimals: 6 };
  const key = `${entry.network.toLowerCase()}|${entry.asset.toLowerCase()}`;
  const known = KNOWN_ASSETS[key];
  if (known) return { currency: known.currency, decimals: known.decimals };
  return { decimals: 6 }; // unknown asset → omit currency, keep decimals default for price_hint
}

function priceHintFrom(amount: string, decimals: number): string | undefined {
  const n = Number(amount);
  if (!Number.isFinite(n)) return undefined;
  const div = Math.pow(10, decimals);
  const out = n / div;
  // Strip trailing zeros nicely.
  return out.toString();
}

function buildOption(entry: X402AcceptsEntry): PaymentOption | null {
  const network = canonicalNetworkName(entry.network);
  if (!network) return null; // skip rails we can't name
  const { currency, decimals } = currencyAndDecimalsFor(entry);
  const priceHint = priceHintFrom(entry.amount, decimals);
  return {
    protocol: "x402v2",
    ...(entry.scheme && { scheme: entry.scheme }),
    network,
    ...(currency !== undefined && { currency }),
    asset: entry.asset,
    amount: entry.amount,
    ...(priceHint !== undefined && { price_hint: priceHint }),
    pay_to: entry.payTo,
    ...(typeof entry.maxTimeoutSeconds === "number" && { max_timeout_seconds: entry.maxTimeoutSeconds }),
    ...(entry.extra && Object.keys(entry.extra).length > 0 && { extra: entry.extra }),
  };
}

function offerRouteToDescriptorId(serviceSlug: string, route: string): string | null {
  const m = route.match(/^([A-Z]+)\s+(.+)$/);
  if (!m) return null;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  return `frames.${slug(serviceSlug)}.${m[1]!.toLowerCase()}.${slug(m[2]!)}`;
}

function main() {
  if (!existsSync(PROBES_PATH)) {
    console.error(`missing ${PROBES_PATH} — run \`bun scripts/probe-402-frames-registry.ts\` first`);
    process.exit(1);
  }
  const probes = JSON.parse(readFileSync(PROBES_PATH, "utf-8")) as RouteProbe[];

  // Map descriptor id → built payment block (primary + accepts[]).
  const payments = new Map<string, { primary: PaymentOption; accepts: PaymentOption[] }>();
  let probesUsed = 0;
  let probesSkipped = 0;
  for (const probe of probes) {
    if (probe.status !== "ok" || !probe.accepts) {
      probesSkipped++;
      continue;
    }
    const id = offerRouteToDescriptorId(probe.service_slug, probe.route);
    if (!id) {
      probesSkipped++;
      continue;
    }
    const options = probe.accepts.map(buildOption).filter((o): o is BuiltOption => o !== null);
    if (options.length === 0) {
      probesSkipped++;
      continue;
    }
    const [primary, ...rest] = options;
    payments.set(id, { primary: primary!, accepts: rest });
    probesUsed++;
  }
  console.error(`probes consumed: ${probesUsed} used, ${probesSkipped} skipped`);

  let updated = 0;
  let unchanged = 0;
  let noProbe = 0;
  for (const file of readdirSync(TOOLS)) {
    if (!file.startsWith("frames.")) continue;
    const id = file.replace(/\.json$/, "");
    const built = payments.get(id);
    if (!built) {
      noProbe++;
      continue;
    }
    const filePath = resolve(TOOLS, file);
    const desc = JSON.parse(readFileSync(filePath, "utf-8")) as ToolDescriptor;
    const before = JSON.stringify(desc.payment);

    // Preserve protocol from existing if probe didn't set one explicitly
    // (always x402v2 in practice for the frames-registry surface today).
    desc.payment = {
      protocol: built.primary.protocol,
      ...(built.primary.scheme && { scheme: built.primary.scheme }),
      network: built.primary.network,
      ...(built.primary.currency !== undefined && { currency: built.primary.currency }),
      asset: built.primary.asset,
      amount: built.primary.amount,
      ...(built.primary.price_hint !== undefined && { price_hint: built.primary.price_hint }),
      pay_to: built.primary.pay_to,
      ...(built.primary.max_timeout_seconds !== undefined && { max_timeout_seconds: built.primary.max_timeout_seconds }),
      ...(built.primary.extra && { extra: built.primary.extra }),
      ...(built.accepts.length > 0 && { accepts: built.accepts }),
    };

    const after = JSON.stringify(desc.payment);
    if (after === before) {
      unchanged++;
      continue;
    }
    writeFileSync(filePath, JSON.stringify(desc, null, 2) + "\n");
    updated++;
  }

  console.error(`frames.*: updated=${updated}  unchanged=${unchanged}  no_probe=${noProbe}`);
  console.error(`next: run \`bun scripts/backfill-accepts-networks.ts\` to re-stamp the slim index`);
}

main();
