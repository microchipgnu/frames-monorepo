// Catalog client for catalog.frames.ag.
//
// Wraps the published REST surface:
//   GET /catalog                       list ToolDescriptors
//   GET /catalog?capability=<tag>      filter
//   GET /catalog/:id                   list-envelope around one descriptor
//   GET /tools/:id                     bare descriptor (wire format)
//
// Cursor-paginated. ETag-cached. The catalog is content-addressed: every
// descriptor has a stable `descriptor_id` (SHA-256 of canonical JSON).
//
// Used by the curate/discover agent loops to discover paid tools at runtime
// instead of hard-coding a tool palette.

import { retry } from "../util/retry";

const CATALOG_BASE = "https://catalog.frames.ag";

export interface ToolDescriptor {
  pay_protocol: string;
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
    [k: string]: unknown;
  };
  schemas?: Record<string, unknown>;
  /** Computed at the catalog server; SHA-256 of canonical JSON of the descriptor. */
  _descriptor_id?: string;
  /** Catalog metadata (source registry, quality stats). Origin-tagged for filtering. */
  _meta?: {
    catalog?: {
      source?: "bazaar" | "mpp" | "frames";
      [k: string]: unknown;
    };
    quality?: {
      l30DaysTotalCalls?: number;
      [k: string]: unknown;
    };
  };
}

export interface CatalogListResponse {
  pay_protocol: string;
  tools: ToolDescriptor[];
  cursor?: string | null;
}

export interface CatalogClientOptions {
  base?: string;
  /** ETag cache shared across requests. Lets repeated reads short-circuit on 304. */
  etag_cache?: Map<string, { etag: string; body: string }>;
}

export class CatalogClient {
  private base: string;
  private etagCache?: Map<string, { etag: string; body: string }>;
  /** In-memory descriptor cache by id. The catalog is content-addressed so caching by id is safe within a session. */
  private descriptorCache = new Map<string, ToolDescriptor>();

  constructor(opts: CatalogClientOptions = {}) {
    this.base = opts.base ?? CATALOG_BASE;
    this.etagCache = opts.etag_cache;
  }

  /**
   * List/filter descriptors. Cursor-paginated.
   * Filters out zero-traffic Bazaar tools (`quality.l30DaysTotalCalls === 0`)
   * per PLAN.md §10 decision #6 (catalog spam filtering).
   */
  async search(opts: { capability?: string; cursor?: string; limit?: number } = {}): Promise<CatalogListResponse> {
    const qs = new URLSearchParams();
    if (opts.capability) qs.set("capability", opts.capability);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.limit) qs.set("limit", String(opts.limit));
    const tail = qs.toString();
    const url = `${this.base}/catalog${tail ? `?${tail}` : ""}`;
    const raw = (await this.fetchJson(url)) as CatalogListResponse;
    // Server-side spam filter
    const filtered = raw.tools.filter((t) => {
      const calls = t._meta?.quality?.l30DaysTotalCalls;
      return calls === undefined || calls > 0;
    });
    // Cache resolved descriptors by id
    for (const t of filtered) this.descriptorCache.set(t.id, t);
    return { pay_protocol: raw.pay_protocol, tools: filtered, cursor: raw.cursor };
  }

  /** Resolve a single descriptor by id. Cached after first fetch. */
  async get(id: string): Promise<ToolDescriptor | null> {
    const cached = this.descriptorCache.get(id);
    if (cached) return cached;
    try {
      const t = (await this.fetchJson(`${this.base}/tools/${encodeURIComponent(id)}`)) as ToolDescriptor;
      this.descriptorCache.set(id, t);
      return t;
    } catch (e) {
      if (e instanceof CatalogClientError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Resolve descriptor by id and build the invocation request for the agent
   * to send via the paidFetch wrapper. Returns:
   *   - `url`, `method`, `headers`, `body` ready to feed `paidFetch`
   *   - `price_hint` for the agent's budget pre-check
   *   - `descriptor` itself for downstream provenance
   *
   * Does NOT actually invoke — the call site decides whether to call paidFetch
   * (paid) or fall back to free fetch (e.g. when wallets aren't configured).
   */
  async buildInvocation(
    id: string,
    args: Record<string, unknown>,
  ): Promise<{
    descriptor: ToolDescriptor;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    price_hint?: string;
  } | null> {
    const descriptor = await this.get(id);
    if (!descriptor) return null;
    const method = descriptor.invocation.method.toUpperCase();
    const url = descriptor.invocation.url;
    const headers: Record<string, string> = { "content-type": "application/json" };
    let body: string | undefined;
    if (method === "GET" || method === "HEAD") {
      // GET tools encode args as query string
      const qs = toQueryString(args);
      const sep = url.includes("?") ? "&" : "?";
      return {
        descriptor,
        url: qs ? `${url}${sep}${qs}` : url,
        method,
        headers: { accept: "application/json" },
        body: undefined,
        ...(descriptor.payment.price_hint ? { price_hint: descriptor.payment.price_hint } : {}),
      };
    }
    body = JSON.stringify(args);
    return {
      descriptor,
      url,
      method,
      headers,
      body,
      ...(descriptor.payment.price_hint ? { price_hint: descriptor.payment.price_hint } : {}),
    };
  }

  // -------------------------------------------------------------------------

  private async fetchJson(url: string): Promise<unknown> {
    return await retry(() => this.doFetchJson(url));
  }

  private async doFetchJson(url: string): Promise<unknown> {
    const headers = new Headers({ accept: "application/json" });
    const cached = this.etagCache?.get(url);
    if (cached) headers.set("If-None-Match", cached.etag);
    const res = await fetch(url, { headers });
    if (res.status === 304 && cached) {
      return JSON.parse(cached.body);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CatalogClientError(`${url}: ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    const body = await res.text();
    const etag = res.headers.get("ETag");
    if (etag && this.etagCache) this.etagCache.set(url, { etag, body });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // The catalog publishes `ETag: W/"<sha12>"` matching the descriptor_id
    // (per catalog README: "Each response carries ETag matching the
    // descriptor's descriptor_id"). For single-descriptor responses, lift
    // it onto the descriptor itself so callers don't need to re-canonicalize
    // + re-hash. For list responses, the per-tool descriptor_id is computed
    // server-side only — we can't recover it cheaply from a list, so list
    // entries get _descriptor_id = undefined (and tool_invoke falls back
    // to the slug `id` for receipt provenance).
    if (etag && parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("tools" in parsed)) {
      const stripped = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
      (parsed as { _descriptor_id?: string })._descriptor_id = stripped.startsWith("sha")
        ? stripped
        : `etag-${stripped}`;
    }
    return parsed;
  }
}

export class CatalogClientError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "CatalogClientError";
  }
}

function toQueryString(args: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return qs.toString();
}
