#!/usr/bin/env bun
// Probe each bazaar host's sample endpoints to detect MPP / x402 advertising
// directly, instead of relying on mppscan indexing lag.
//
// Three protocols to detect on a 402 response:
//   1. x402 v1 — body JSON with `accepts[]: [{scheme, network, payTo, ...}]`
//   2. x402 v2 — `payment-required: <base64>` header (or same envelope in body)
//   3. MPP / paymentauth.org — `WWW-Authenticate: Payment id="...",
//      method="...", request="<base64>"`, possibly with multiple Payment
//      challenges concatenated. Discovered on mpp.browserbase.com — Browserbase
//      advertises Tempo + Stripe via this scheme but never made it into mppscan.
//
// Sibling-host strategy: for each bazaar host like `x402.foo.com`, we ALSO
// probe `mpp.foo.com` and `payments.foo.com`. That's how we catch the
// Browserbase pattern (separate host per protocol) without needing the
// bazaar to index MPP-only hosts.
//
// Caching: results land in staging/probe-results.json keyed by host. A host
// probed within --max-age-days (default 7) is reused. Pass --refresh to bust.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { describeNetwork, isInfraHost, canonicalHost } from "./host.ts";

type Bazaar = {
  host: string;
  bazaar_resource_count: number;
  sample_resources: { url: string }[];
};

type ProbeRow = {
  host: string;
  probe_endpoint: string | null;
  probe_status: "ok" | "non-402" | "timeout" | "error" | "skipped";
  http_status: number | null;
  advertises_x402: boolean;
  advertises_mpp: boolean;
  // The "method" string the merchant advertises — for x402 this is the same
  // as the network alias; for MPP it's the method label (tempo, stripe, base,
  // solana, ...). We keep raw values plus a normalized network_names list.
  advertised_methods: string[];
  advertised_networks: string[]; // friendly chain names (e.g. ["Tempo","Stripe","Base"])
  advertised_recipients: string[]; // join key for x402scan
  protocol_signals: string[]; // ["www-authenticate-payment","payment-required-header","x402-body"]
  sibling_of: string | null; // if this row is for mpp.foo.com, the seed was foo.com
  observed_at: string;
};

// Parse RFC 7235 WWW-Authenticate, returning each challenge as a map of
// auth-params. The Browserbase response concatenates two Payment challenges
// in one header — comma-separated at the challenge level, but commas also
// appear inside the param list. We walk character-by-character respecting
// double-quoted strings, then re-split into challenges by detecting the
// scheme token (capitalized word at start of a segment).
function parseWwwAuthenticate(header: string): Array<{
  scheme: string;
  params: Record<string, string>;
}> {
  const tokens: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '"' && header[i - 1] !== "\\") inQuote = !inQuote;
    if (c === "," && !inQuote) {
      tokens.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) tokens.push(buf.trim());

  // Each token is either "Scheme key=value" (start of challenge) or "key=value"
  // (continuation). Detect the start by leading scheme word: a token whose
  // first whitespace-separated word is a single capitalized identifier
  // followed by a key=value pair.
  const challenges: Array<{ scheme: string; params: Record<string, string> }> = [];
  let current: { scheme: string; params: Record<string, string> } | null = null;
  for (const tok of tokens) {
    const schemeMatch = tok.match(/^([A-Z][a-zA-Z0-9_-]*)\s+(.+)$/);
    const startsChallenge =
      schemeMatch && schemeMatch[2].includes("=");
    if (startsChallenge) {
      if (current) challenges.push(current);
      current = { scheme: schemeMatch![1], params: {} };
      const rest = schemeMatch![2];
      const kv = rest.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.*)$/);
      if (kv) current.params[kv[1].toLowerCase()] = stripQuotes(kv[2]);
    } else if (current) {
      const kv = tok.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.*)$/);
      if (kv) current.params[kv[1].toLowerCase()] = stripQuotes(kv[2]);
    }
  }
  if (current) challenges.push(current);
  return challenges;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function safeBase64Decode(s: string): string | null {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function safeJson<T = unknown>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// Normalize a method/network token (the union of x402 `network` and MPP
// `method`) to a friendly chain name. Falls back to capitalize-first for
// non-chain methods like "stripe".
function normalizeMethod(token: string): string {
  const lc = token.toLowerCase();
  // Known method names that aren't networks
  if (lc === "stripe" || lc === "card" || lc === "ach" || lc === "wire") {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
  const info = describeNetwork(token);
  return info.name;
}

// Decode the per-challenge `request` blob to extract recipient + chain context.
// Returns network hints, NOT authoritative — the `method` field is the primary
// signal.
function decodeChallengeRequest(b64: string): {
  recipient: string | null;
  chainId: number | null;
} {
  const json = safeBase64Decode(b64);
  if (!json) return { recipient: null, chainId: null };
  const obj = safeJson<{
    recipient?: string;
    methodDetails?: { chainId?: number };
  }>(json);
  if (!obj) return { recipient: null, chainId: null };
  return {
    recipient: obj.recipient?.toLowerCase() ?? null,
    chainId: obj.methodDetails?.chainId ?? null,
  };
}

async function probeOne(
  host: string,
  endpoint: string,
  siblingOf: string | null,
  timeoutMs: number,
): Promise<ProbeRow | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    return {
      host,
      probe_endpoint: endpoint,
      probe_status: e?.name === "AbortError" ? "timeout" : "error",
      http_status: null,
      advertises_x402: false,
      advertises_mpp: false,
      advertised_methods: [],
      advertised_networks: [],
      advertised_recipients: [],
      protocol_signals: [],
      sibling_of: siblingOf,
      observed_at: new Date().toISOString(),
    };
  }
  clearTimeout(timer);

  // Only 402 carries a payment challenge. We still record non-402 so we don't
  // probe the same dead endpoint repeatedly.
  if (res.status !== 402) {
    return {
      host,
      probe_endpoint: endpoint,
      probe_status: "non-402",
      http_status: res.status,
      advertises_x402: false,
      advertises_mpp: false,
      advertised_methods: [],
      advertised_networks: [],
      advertised_recipients: [],
      protocol_signals: [],
      sibling_of: siblingOf,
      observed_at: new Date().toISOString(),
    };
  }

  const headersLc = new Headers(res.headers);
  const wwwAuth = headersLc.get("www-authenticate") ?? "";
  const payReq = headersLc.get("payment-required") ?? "";
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* body read failed, keep going on headers alone */
  }

  const methods = new Set<string>();
  const networks = new Set<string>();
  const recipients = new Set<string>();
  const signals = new Set<string>();
  let mpp = false;
  let x402 = false;

  // (1) WWW-Authenticate Payment challenges — MPP
  if (wwwAuth) {
    const challenges = parseWwwAuthenticate(wwwAuth);
    const paymentChallenges = challenges.filter(
      (c) => c.scheme.toLowerCase() === "payment",
    );
    if (paymentChallenges.length > 0) {
      signals.add("www-authenticate-payment");
      // Multi-method advertising is the MPP signal. A single Payment
      // challenge is still MPP-protocol but we only flag advertises_mpp=true
      // when there's >1 method (else it's degenerate / equivalent to x402).
      // The advertised_methods list captures everything either way.
      if (paymentChallenges.length >= 2) mpp = true;
      for (const ch of paymentChallenges) {
        const method = ch.params.method;
        if (method) methods.add(method);
        if (method) networks.add(normalizeMethod(method));
        const req = ch.params.request;
        if (req) {
          const decoded = decodeChallengeRequest(req);
          if (decoded.recipient) recipients.add(decoded.recipient);
          if (decoded.chainId) {
            const info = describeNetwork(`eip155:${decoded.chainId}`);
            networks.add(info.name);
          }
        }
      }
    }
  }

  // (2) payment-required header — x402 v2 envelope
  if (payReq) {
    const decoded = safeBase64Decode(payReq);
    const env = decoded ? safeJson<{ accepts?: any[] }>(decoded) : null;
    if (env?.accepts && Array.isArray(env.accepts)) {
      signals.add("payment-required-header");
      x402 = true;
      for (const acc of env.accepts) {
        if (typeof acc?.network === "string") {
          methods.add(acc.network);
          networks.add(describeNetwork(acc.network).name);
        }
        if (typeof acc?.payTo === "string") recipients.add(acc.payTo.toLowerCase());
      }
      // ≥2 distinct networks in one envelope = MPP-style advertising via x402 v2
      const distinctNets = new Set(env.accepts.map((a: any) => a?.network).filter(Boolean));
      if (distinctNets.size >= 2) mpp = true;
    }
  }

  // (3) JSON body with x402 v1 accepts[] OR paymentauth problem doc
  if (body) {
    const env = safeJson<{
      accepts?: any[];
      type?: string;
      challenges?: any[];
    }>(body);
    if (env?.accepts && Array.isArray(env.accepts)) {
      signals.add("x402-body");
      x402 = true;
      for (const acc of env.accepts) {
        if (typeof acc?.network === "string") {
          methods.add(acc.network);
          networks.add(describeNetwork(acc.network).name);
        }
        if (typeof acc?.payTo === "string") recipients.add(acc.payTo.toLowerCase());
      }
      const distinctNets = new Set(env.accepts.map((a: any) => a?.network).filter(Boolean));
      if (distinctNets.size >= 2) mpp = true;
    } else if (env?.type?.includes("paymentauth.org")) {
      // Body confirms paymentauth.org / MPP framing — the real challenge data
      // is in the WWW-Authenticate header, which we already parsed above.
      signals.add("paymentauth-body");
    }
  }

  return {
    host,
    probe_endpoint: endpoint,
    probe_status: "ok",
    http_status: 402,
    advertises_x402: x402,
    advertises_mpp: mpp,
    advertised_methods: [...methods].sort(),
    advertised_networks: [...networks].sort(),
    advertised_recipients: [...recipients].sort(),
    protocol_signals: [...signals].sort(),
    sibling_of: siblingOf,
    observed_at: new Date().toISOString(),
  };
}

// Bazaar resources are URLs to specific paid endpoints. Take up to 2 to give
// the probe a fair shot if the first one is broken; cap aggressively because
// probing 700 hosts × 2 endpoints is already 1400 requests.
function pickEndpoints(b: Bazaar): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of b.sample_resources ?? []) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r.url);
    if (out.length >= 2) break;
  }
  // Fallback: probe the host root. Real merchants almost never 402 on `/` but
  // it costs us nothing.
  if (out.length === 0) out.push(`https://${b.host}/`);
  return out;
}

// For each bazaar host, derive likely MPP-sibling hosts. mpp.browserbase.com
// is the canonical example — same brand, different protocol, different host.
function siblingCandidates(host: string): string[] {
  // Bare brand = strip api./x402./payments./mpp. prefix
  const bare = host
    .replace(/^x402\.api\./, "")
    .replace(/^payments\.api\./, "")
    .replace(/^mpp\.api\./, "")
    .replace(/^(x402|mpp|payments|api)\./, "");
  if (bare === host) return [`mpp.${host}`, `payments.${host}`];
  const candidates = [`mpp.${bare}`, `payments.${bare}`, `x402.${bare}`];
  return candidates.filter((c) => c !== host);
}

async function runConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  let done = 0;
  const workers = Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
        done++;
        if (onProgress && done % 25 === 0) onProgress(done, items.length);
      }
    });
  await Promise.all(workers);
  if (onProgress) onProgress(done, items.length);
  return results;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const refresh = args.has("--refresh");
  const maxAgeDays = 7;
  const concurrency = 10;
  const timeoutMs = 8000;

  const bazaar: Bazaar[] = JSON.parse(
    readFileSync("staging/bazaar.json", "utf8"),
  );

  // Probe-budget shaping: skip mass-listers (orbisapi has 32k resources — its
  // x402 surface is already well-known and we'd burn the probe budget on
  // proxy URLs) and infra hosts (auto-generated, not a brand to surface).
  const seedHosts = bazaar.filter(
    (b) => b.bazaar_resource_count > 0 && b.bazaar_resource_count <= 500 && !isInfraHost(b.host),
  );

  // Cache: skip hosts probed within max-age-days unless --refresh.
  const cachePath = "staging/probe-results.json";
  const existing: ProbeRow[] = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : [];
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Map<string, ProbeRow>();
  if (!refresh) {
    for (const r of existing) {
      if (r.observed_at > cutoff) fresh.set(r.host, r);
    }
  }

  // Build the work list: each item is { host, endpoints[], siblingOf }.
  type Work = { host: string; endpoints: string[]; siblingOf: string | null };
  const work: Work[] = [];
  for (const b of seedHosts) {
    if (!fresh.has(b.host)) {
      work.push({ host: b.host, endpoints: pickEndpoints(b), siblingOf: null });
    }
    for (const sib of siblingCandidates(b.host)) {
      const sibCanon = canonicalHost(sib);
      if (!sibCanon || fresh.has(sibCanon)) continue;
      // Sibling host probe: rewrite the seed's known paid endpoints onto the
      // sibling host. This is how Browserbase's `mpp.browserbase.com` gets
      // probed at `/browser/session/create` (the path our bazaar already knows
      // from `x402.browserbase.com`). Pure "/" probes miss the real endpoint
      // path 90% of the time; this trick gets it right by reusing the seed's
      // structure.
      const seedPaths = pickEndpoints(b)
        .map((u) => {
          try {
            return new URL(u).pathname;
          } catch {
            return null;
          }
        })
        .filter((p): p is string => !!p && p.length > 1);
      const sibEndpoints = [
        ...seedPaths.map((p) => `https://${sibCanon}${p}`),
        `https://${sibCanon}/`,
      ];
      work.push({
        host: sibCanon,
        endpoints: sibEndpoints,
        siblingOf: b.host,
      });
    }
  }

  console.error(
    `probe-402: ${work.length} hosts to probe (${fresh.size} cached, ${seedHosts.length} seed hosts in bazaar)`,
  );
  const started = Date.now();

  // For each host, try its endpoints in order until one returns 402.
  // Otherwise emit the first non-402 row.
  const rows = await runConcurrent(
    work,
    async (w) => {
      let last: ProbeRow | null = null;
      for (const ep of w.endpoints) {
        const r = await probeOne(w.host, ep, w.siblingOf, timeoutMs);
        if (r && r.probe_status === "ok") return r;
        last = r ?? last;
      }
      return (
        last ?? {
          host: w.host,
          probe_endpoint: w.endpoints[0] ?? null,
          probe_status: "error" as const,
          http_status: null,
          advertises_x402: false,
          advertises_mpp: false,
          advertised_methods: [],
          advertised_networks: [],
          advertised_recipients: [],
          protocol_signals: [],
          sibling_of: w.siblingOf,
          observed_at: new Date().toISOString(),
        }
      );
    },
    concurrency,
    (done, total) => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.error(`  ${done}/${total} (${elapsed}s)`);
    },
  );

  const all = [...fresh.values(), ...rows];
  // Drop sibling probes that came back non-402 — they're noise (we guessed
  // a host that doesn't exist). Keep all seed-host rows even when non-402
  // so we know we tried.
  const cleaned = all.filter(
    (r) => r.sibling_of === null || r.probe_status === "ok",
  );

  writeFileSync(cachePath, JSON.stringify(cleaned, null, 2));

  const ok = cleaned.filter((r) => r.probe_status === "ok").length;
  const mpp = cleaned.filter((r) => r.advertises_mpp).length;
  const x402 = cleaned.filter((r) => r.advertises_x402).length;
  const siblings = cleaned.filter((r) => r.sibling_of && r.probe_status === "ok").length;
  console.error(
    `\n✓ probed ${rows.length} new, ${cleaned.length} total in cache (${ok} returned 402, ${x402} advertise x402, ${mpp} advertise MPP, ${siblings} via sibling host)`,
  );
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
