import { Hono } from "hono";
import type { CatalogCache } from "./cache.js";
import type { ContentSource } from "./content.js";
import {
  fetchDescriptor,
  fetchIndex,
  fetchLongTailIndex,
  fetchMerchant,
  fetchMerchantIndex,
  fetchRefreshMeta,
} from "./content.js";
import type {
  ListResponse,
  MerchantEntity,
  MerchantListResponse,
  SearchResponse,
  ToolDescriptor,
} from "./types.js";

export interface HandlerDeps {
  cache: CatalogCache;
  content: ContentSource;
  webhookSecret?: string;
}

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=600";
const PAY_PROTOCOL = "0.0.1";
const CATALOG_PROTOCOL = "0.0.1";

async function getMerchantIndex(
  deps: HandlerDeps,
): Promise<MerchantEntity[]> {
  const cacheKey = "merchant-index";
  const cached = await deps.cache.get(cacheKey);
  if (cached) return JSON.parse(cached.body) as MerchantEntity[];
  const list = await fetchMerchantIndex(deps.content);
  await deps.cache.set(
    cacheKey,
    {
      etag: `W/"merchants-${list.length}"`,
      body: JSON.stringify(list),
      contentType: "application/json",
    },
    60,
  );
  return list;
}

async function getToolIndex(
  deps: HandlerDeps,
): Promise<ToolDescriptor[]> {
  return getCachedIndex(deps, "index", fetchIndex);
}

async function getLongTailToolIndex(
  deps: HandlerDeps,
): Promise<ToolDescriptor[]> {
  return getCachedIndex(deps, "index-longtail", fetchLongTailIndex);
}

async function getCachedIndex(
  deps: HandlerDeps,
  cacheKey: string,
  fetcher: (c: typeof deps.content) => Promise<ToolDescriptor[]>,
): Promise<ToolDescriptor[]> {
  const cached = await deps.cache.get(cacheKey);
  if (cached) return JSON.parse(cached.body) as ToolDescriptor[];
  const list = await fetcher(deps.content);
  await deps.cache.set(
    cacheKey,
    {
      etag: `W/"${cacheKey}-${list.length}"`,
      body: JSON.stringify(list),
      contentType: "application/json",
    },
    60,
  );
  return list;
}

// quality param → which index file(s) to fetch. Default (curated) loads
// only the small index; long-tail explicitly loads only the long-tail file;
// "any" merges both.
async function getIndexForQuality(
  deps: HandlerDeps,
  quality: "curated" | "long-tail" | "any",
): Promise<ToolDescriptor[]> {
  if (quality === "curated") return getToolIndex(deps);
  if (quality === "long-tail") return getLongTailToolIndex(deps);
  const [a, b] = await Promise.all([getToolIndex(deps), getLongTailToolIndex(deps)]);
  return [...a, ...b];
}

function applyMerchantFilters(
  merchants: MerchantEntity[],
  filters: {
    capability?: string;
    rail?: string;
    active?: boolean;
    recognized?: boolean;
    includeInfra?: boolean;
    q?: string;
  },
): MerchantEntity[] {
  let out = merchants;
  if (!filters.includeInfra) out = out.filter((m) => !m.is_infra);
  if (filters.active) out = out.filter((m) => m.is_active_14d);
  if (filters.recognized) out = out.filter((m) => m.is_recognized);
  if (filters.capability) {
    const cap = filters.capability.toLowerCase();
    out = out.filter((m) => m.category.toLowerCase() === cap);
  }
  if (filters.rail) {
    const rail = filters.rail.toLowerCase();
    out = out.filter((m) =>
      m.network_names.toLowerCase().split(/,\s*/).includes(rail),
    );
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    out = out.filter(
      (m) =>
        m.host.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q) ||
        (m.x_guidance ?? "").toLowerCase().includes(q),
    );
  }
  return out;
}

// quality query param: curated (default) | long-tail | any
function parseQuality(q: string | undefined): "curated" | "long-tail" | "any" {
  if (q === "long-tail" || q === "any") return q;
  return "curated";
}

// Tool list-index entries no longer carry _signals — they carry a `host`
// join key. The server filters by joining to the merchant entity at
// request time.
async function getMerchantByHost(
  deps: HandlerDeps,
): Promise<Map<string, MerchantEntity>> {
  const merchants = await getMerchantIndex(deps);
  return new Map(merchants.map((m) => [m.host, m]));
}

// Aliases the slim entry's `host` to the merchant's canonical host so the
// join works even when bazaar uses `api.foo.com` and the merchant rolled
// up to `foo.com`. Same logic as scripts/host.ts aliasCandidate.
const ALIAS_PREFIXES = ["x402.", "api.", "mpp.", "payments.", "www."];
function resolveMerchantForHost(
  host: string | null | undefined,
  byHost: Map<string, MerchantEntity>,
): MerchantEntity | undefined {
  if (!host) return undefined;
  const direct = byHost.get(host);
  if (direct) return direct;
  for (const p of ALIAS_PREFIXES) {
    if (host.startsWith(p)) {
      const alias = host.slice(p.length);
      const m = byHost.get(alias);
      if (m) return m;
    }
  }
  return undefined;
}

function merchantQuality(m: MerchantEntity | undefined): "curated" | "long-tail" {
  // A merchant is curated if it has a recognized brand name.
  return m?.is_recognized ? "curated" : "long-tail";
}

// ─── Search ranking ────────────────────────────────────────────────────────
// Tokenize the query: split on non-word chars, lowercase, drop empties +
// 1-char tokens (too noisy). Returns an empty array for a missing query.
function tokenize(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// Score a tool against a token list. Higher is better.
//   +12 per token present in title (or +25 if whole phrase appears intact)
//   +3  per token present in description
//   +1  per token present in id
//   +6  bonus if every token landed somewhere
//   +4  bonus when source is mpp/frames-registry (curated catalogs)
// Returns 0 when no token matched — caller filters score>0 unless q empty.
function scoreToolMatch(
  t: ToolDescriptor,
  tokens: string[],
  curatedSource: boolean,
): number {
  if (tokens.length === 0) return 1; // no q → everything is tied
  const title = t.title.toLowerCase();
  const desc = (t.description ?? "").toLowerCase();
  const id = t.id.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const tok of tokens) {
    let tokenScored = false;
    if (title.includes(tok)) { score += 12; tokenScored = true; }
    if (desc.includes(tok)) { score += 3; tokenScored = true; }
    if (id.includes(tok)) { score += 1; tokenScored = true; }
    if (tokenScored) hits++;
  }
  if (hits === 0) return 0;
  if (hits === tokens.length) score += 6;
  // Phrase bonus
  const phrase = tokens.join(" ");
  if (phrase.length >= 4 && title.includes(phrase)) score += 25;
  if (curatedSource) score += 4;
  return score;
}

function scoreMerchantMatch(
  m: MerchantEntity,
  tokens: string[],
): number {
  if (tokens.length === 0) return 1;
  const name = m.display_name.toLowerCase();
  const host = m.host.toLowerCase();
  const desc = (m.description ?? "").toLowerCase();
  const guidance = (m.x_guidance ?? "").toLowerCase();
  let score = 0;
  let hits = 0;
  for (const tok of tokens) {
    let s = false;
    if (name.includes(tok)) { score += 14; s = true; }
    if (host.includes(tok)) { score += 6; s = true; }
    if (desc.includes(tok)) { score += 4; s = true; }
    if (guidance.includes(tok)) { score += 3; s = true; }
    if (s) hits++;
  }
  if (hits === 0) return 0;
  if (hits === tokens.length) score += 8;
  if (m.is_recognized) score += 5;
  // Volume bonus — capped so it doesn't dominate text relevance.
  score += Math.min(Math.log10(Math.max(m.total_calls_30d, 1)), 5);
  return score;
}

function passesQualityFilter(
  m: MerchantEntity | undefined,
  q: "curated" | "long-tail" | "any",
): boolean {
  if (q === "any") return true;
  return merchantQuality(m) === q;
}

function paginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number,
  cursorField: "host" | "id",
): { page: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    start = items.findIndex(
      (x) => ((x as Record<string, unknown>)[cursorField] as string) > cursor,
    );
    if (start === -1) start = items.length;
  }
  const page = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  const nextCursor =
    hasMore && page.length > 0
      ? (((page[page.length - 1] as Record<string, unknown>)[cursorField] as string) ?? null)
      : null;
  return { page, nextCursor };
}

export function createHandler(deps: HandlerDeps) {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      name: "catalog",
      spec: `pay ${PAY_PROTOCOL}`,
      catalog_protocol: CATALOG_PROTOCOL,
      content_base: deps.content.baseUrl,
      routes: [
        "GET /tools/:id",
        "GET /catalog?q=&capability=&rail=&cursor=&limit=",
        "GET /catalog/:id",
        "GET /capabilities?quality=&min_count=",
        "GET /merchants?q=&capability=&rail=&active=&recognized=&cursor=&limit=",
        "GET /merchants/:host",
        "GET /search?q=",
        "GET /_meta",
        "POST /webhooks/invalidate",
      ],
    }),
  );


  // /capabilities — flat list of every capability tag in the catalog with
  // tool counts and a few example tool IDs per tag. Lets discoverers see
  // the canonical taxonomy at a glance instead of enumerating 1,100 tools
  // to figure out which tag names actually exist.
  //
  // Verified motivation (2026-05-25): the layoffs-2026 prompt called
  // catalog_search() with `news-search`, `social-search`, `semantic-search`,
  // `scrape` — none of those tag names exist in the catalog. The real
  // names are `news` (6), `social` (123), `semantic` (4), and there is no
  // scrape tag at all. /capabilities exposes that truth in one request.
  app.get("/capabilities", async (c) => {
    const quality = parseQuality(c.req.query("quality"));
    const minCount = Math.max(
      parseInt(c.req.query("min_count") ?? "1", 10) || 1,
      1,
    );
    const exampleLimit = clamp(
      parseInt(c.req.query("examples") ?? "3", 10) || 3,
      0,
      10,
    );

    const cacheKey = `capabilities:${quality}:${minCount}:${exampleLimit}`;
    let cached = await deps.cache.get(cacheKey);
    if (!cached) {
      const index = await getIndexForQuality(deps, quality);
      const counts = new Map<string, { count: number; examples: string[] }>();
      for (const t of index) {
        for (const cap of t.capabilities ?? []) {
          let bucket = counts.get(cap);
          if (!bucket) {
            bucket = { count: 0, examples: [] };
            counts.set(cap, bucket);
          }
          bucket.count++;
          if (bucket.examples.length < exampleLimit) bucket.examples.push(t.id);
        }
      }
      const capabilities = Array.from(counts.entries())
        .filter(([, v]) => v.count >= minCount)
        .map(([name, v]) => ({ name, count: v.count, examples: v.examples }))
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
      const body = {
        pay_protocol: PAY_PROTOCOL,
        catalog_protocol: CATALOG_PROTOCOL,
        quality,
        total: capabilities.length,
        capabilities,
      };
      cached = {
        etag: `W/"capabilities-${quality}-${capabilities.length}"`,
        body: JSON.stringify(body),
        contentType: "application/json",
      };
      await deps.cache.set(cacheKey, cached, 60);
    }
    c.header("Cache-Control", CACHE_CONTROL);
    return new Response(cached.body, {
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": CACHE_CONTROL,
      },
    });
  });

  app.get("/_meta", async (c) => {
    const cacheKey = "refresh-meta";
    let cached = await deps.cache.get(cacheKey);
    if (!cached) {
      const meta = await fetchRefreshMeta(deps.content);
      if (!meta) return c.json({ error: { code: "NoMeta" } }, 404);
      cached = {
        etag: `W/"meta-${meta.refreshed_at}"`,
        body: JSON.stringify(meta),
        contentType: "application/json",
      };
      await deps.cache.set(cacheKey, cached, 60);
    }
    c.header("Cache-Control", CACHE_CONTROL);
    return new Response(cached.body, {
      headers: { "Content-Type": cached.contentType, "Cache-Control": CACHE_CONTROL },
    });
  });

  app.get("/tools/:id", async (c) => {
    const id = c.req.param("id");
    const cacheKey = `tools:${id}`;
    const ifNoneMatch = c.req.header("if-none-match");

    let entry = await deps.cache.get(cacheKey);
    if (!entry) {
      const fetched = await fetchDescriptor(deps.content, id);
      if (!fetched) {
        return c.json({ error: { code: "NotFound" } }, 404);
      }
      entry = {
        etag: fetched.descriptor_id,
        body: JSON.stringify(fetched.descriptor),
        contentType: "application/json",
      };
      await deps.cache.set(cacheKey, entry, 60);
    }

    // Weak ETag — content-bound rather than byte-bound, so it survives
    // server-side compression negotiation. Clients strip strong etags
    // when they decompress, which would otherwise hide our descriptor_id.
    const weakEtag = `W/"${entry.etag}"`;
    // Also expose the raw SHA on a custom header for clients that can't
    // (or won't) parse weak-etag syntax.
    const xDescriptorId = entry.etag;

    if (ifNoneMatch === weakEtag || ifNoneMatch === entry.etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: weakEtag,
          "X-Descriptor-Id": xDescriptorId,
          "Cache-Control": CACHE_CONTROL,
        },
      });
    }

    return new Response(entry.body, {
      headers: {
        "Content-Type": entry.contentType,
        ETag: weakEtag,
        "X-Descriptor-Id": xDescriptorId,
        "Cache-Control": CACHE_CONTROL,
      },
    });
  });

  app.get("/catalog/:id", async (c) => {
    const id = c.req.param("id");
    const fetched = await fetchDescriptor(deps.content, id);
    if (!fetched) {
      return c.json({ error: { code: "NotFound" } }, 404);
    }
    c.header("ETag", fetched.descriptor_id);
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json({
      pay_protocol: PAY_PROTOCOL,
      tool: fetched.descriptor,
      descriptor_id: fetched.descriptor_id,
    });
  });

  app.get("/catalog", async (c) => {
    const capability = c.req.query("capability");
    const q = c.req.query("q")?.trim().toLowerCase();
    const rail = c.req.query("rail")?.trim().toLowerCase();
    const active = c.req.query("active") === "true";
    const recognized = c.req.query("recognized") === "true";
    const quality = parseQuality(c.req.query("quality"));
    const cursor = c.req.query("cursor");
    const limit = clamp(
      parseInt(c.req.query("limit") ?? "100", 10) || 100,
      1,
      500,
    );

    const [index, merchantsByHost] = await Promise.all([
      getIndexForQuality(deps, quality),
      getMerchantByHost(deps),
    ]);

    // Signals filtering via merchant join. (Quality is already enforced
    // by which file we loaded — no double-check needed.)
    let filtered = index.filter((t) => {
      const m = resolveMerchantForHost(t.host, merchantsByHost);
      if (active && m && !m.is_active_14d) return false;
      if (recognized && !m?.is_recognized) return false;
      if (rail) {
        // Rail matches if EITHER the merchant's primary network_names
        // OR the descriptor's accepts_networks contains it. The latter
        // surfaces multi-rail descriptors whose alternate rails aren't
        // reflected in the merchant's primary listing — e.g. a tool that
        // settles on base/USDC by default but advertises an accepts[]
        // entry for solana-mainnet/CASH.
        const merchantRails = m?.network_names.toLowerCase().split(/,\s*/).filter(Boolean) ?? [];
        const descriptorRails = (t.accepts_networks ?? t.payment.network ?? "")
          .toLowerCase()
          .split(/,\s*/)
          .filter(Boolean);
        const combined = new Set([...merchantRails, ...descriptorRails]);
        if (!combined.has(rail)) return false;
      }
      return true;
    });
    if (capability) {
      filtered = filtered.filter((t) => t.capabilities.includes(capability));
    }

    // Score + sort. With no q, score is uniform so cursor pagination still
    // works (sort is stable on equal score). With q, the highest-scoring
    // matches come first.
    const tokens = tokenize(q);
    if (tokens.length > 0) {
      const scored = filtered
        .map((t) => {
          const m = resolveMerchantForHost(t.host, merchantsByHost);
          const curatedSource =
            t._meta?.catalog === "mpp" ||
            t._meta?.catalog === "frames-registry" ||
            !!m?.is_recognized;
          return { t, score: scoreToolMatch(t, tokens, curatedSource) };
        })
        .filter((x) => x.score > 0);
      scored.sort((a, b) => b.score - a.score || (a.t.id < b.t.id ? -1 : 1));
      filtered = scored.map((x) => x.t);
    }

    const { page, nextCursor } = paginate(filtered, cursor, limit, "id");

    const body: ListResponse = {
      pay_protocol: PAY_PROTOCOL,
      tools: page,
      cursor: nextCursor,
    };
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(body);
  });

  // ─── Merchant routes ────────────────────────────────────────────────────

  app.get("/merchants", async (c) => {
    const q = c.req.query("q")?.trim().toLowerCase();
    const capability = c.req.query("capability");
    const rail = c.req.query("rail")?.trim().toLowerCase();
    const active = c.req.query("active") === "true";
    const recognized = c.req.query("recognized") === "true";
    const includeInfra = c.req.query("include_infra") === "true";
    const cursor = c.req.query("cursor");
    const limit = clamp(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1, 500);

    const merchants = await getMerchantIndex(deps);
    const filtered = applyMerchantFilters(merchants, {
      q,
      capability,
      rail,
      active,
      recognized,
      includeInfra,
    });
    const { page, nextCursor } = paginate(filtered, cursor, limit, "host");

    const body: MerchantListResponse = {
      catalog_protocol: CATALOG_PROTOCOL,
      merchants: page,
      cursor: nextCursor,
    };
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(body);
  });

  app.get("/merchants/:host", async (c) => {
    const host = c.req.param("host");
    const cacheKey = `merchant:${host}`;
    let entry = await deps.cache.get(cacheKey);
    if (!entry) {
      const m = await fetchMerchant(deps.content, host);
      if (!m) return c.json({ error: { code: "NotFound" } }, 404);
      entry = {
        etag: `W/"merchant-${host}-${m.observed_at}"`,
        body: JSON.stringify(m),
        contentType: "application/json",
      };
      await deps.cache.set(cacheKey, entry, 60);
    }
    c.header("Cache-Control", CACHE_CONTROL);
    c.header("ETag", entry.etag);
    return new Response(entry.body, {
      headers: {
        "Content-Type": entry.contentType,
        "Cache-Control": CACHE_CONTROL,
        ETag: entry.etag,
      },
    });
  });

  // Cross-grain search. Matches merchants AND tools in one shot. Agent's
  // primary entry point — "find me web search tools that are live on Base"
  // returns merchant cards plus the top tools from each.
  app.get("/search", async (c) => {
    const q = c.req.query("q")?.trim().toLowerCase() ?? "";
    const capability = c.req.query("capability");
    const rail = c.req.query("rail")?.trim().toLowerCase();
    const active = c.req.query("active") === "true";
    const recognized = c.req.query("recognized") !== "false"; // default to recognized-only
    const quality = parseQuality(c.req.query("quality"));
    const includeInfra = c.req.query("include_infra") === "true";
    const limit = clamp(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1, 100);

    if (!q && !capability && !rail) {
      return c.json({ error: { code: "BadRequest", message: "specify q, capability, or rail" } }, 400);
    }

    const [merchants, tools] = await Promise.all([
      getMerchantIndex(deps),
      getIndexForQuality(deps, quality),
    ]);
    const merchantsByHost = new Map(merchants.map((m) => [m.host, m]));

    // Quality on merchants: also gate at the merchant level so the merchant
    // list returned with /search matches the per-tool classification.
    const qualityMerchants = merchants.filter((m) =>
      passesQualityFilter(m, quality),
    );
    let filteredMerchants = applyMerchantFilters(qualityMerchants, {
      q: undefined, // we score with q below instead of pre-filtering on substring
      capability,
      rail,
      active,
      recognized,
      includeInfra,
    });
    const tokens = tokenize(q);
    if (tokens.length > 0) {
      const scored = filteredMerchants
        .map((m) => ({ m, score: scoreMerchantMatch(m, tokens) }))
        .filter((x) => x.score > 0);
      scored.sort((a, b) => b.score - a.score || (a.m.host < b.m.host ? -1 : 1));
      filteredMerchants = scored.map((x) => x.m);
    }
    filteredMerchants = filteredMerchants.slice(0, limit);

    const merchantHosts = new Set(filteredMerchants.map((m) => m.host));
    let filteredTools = tools.filter((t) => {
      const m = resolveMerchantForHost(t.host, merchantsByHost);
      if (!m) return false;
      if (!passesQualityFilter(m, quality)) return false;
      if (!includeInfra && m.is_infra) return false;
      if (active && !m.is_active_14d) return false;
      if (recognized && !m.is_recognized) return false;
      if (capability && m.category.toLowerCase() !== capability.toLowerCase())
        return false;
      if (rail && !m.network_names.toLowerCase().split(/,\s*/).includes(rail))
        return false;
      return merchantHosts.size === 0 || merchantHosts.has(m.host);
    });
    if (tokens.length > 0) {
      const scoredTools = filteredTools
        .map((t) => {
          const m = resolveMerchantForHost(t.host, merchantsByHost);
          const curatedSource =
            t._meta?.catalog === "mpp" ||
            t._meta?.catalog === "frames-registry" ||
            !!m?.is_recognized;
          return { t, score: scoreToolMatch(t, tokens, curatedSource) };
        })
        .filter((x) => x.score > 0);
      scoredTools.sort((a, b) => b.score - a.score || (a.t.id < b.t.id ? -1 : 1));
      filteredTools = scoredTools.map((x) => x.t);
    }
    filteredTools = filteredTools.slice(0, limit);

    const body: SearchResponse = {
      catalog_protocol: CATALOG_PROTOCOL,
      merchants: filteredMerchants,
      tools: filteredTools,
      cursor: null,
    };
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(body);
  });

  app.post("/webhooks/invalidate", async (c) => {
    if (deps.webhookSecret) {
      const sig = c.req.header("x-webhook-secret");
      if (sig !== deps.webhookSecret) {
        return c.json({ error: { code: "Unauthorized" } }, 401);
      }
    }
    await deps.cache.invalidateAll();
    return c.json({ ok: true });
  });

  return app;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
