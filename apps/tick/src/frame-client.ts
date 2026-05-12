// Read-side client for a customer's frame.
//
// Per PLAN.md §10 decision #4 (Mode 1 + read mirror), tick reads frame state
// via frames-cloud's /api/v1/* endpoints. The frames-cloud Worker resolves the
// GitHub repo, runs the projection in-process, and returns typed JSON. tick
// doesn't host its own frame projection — frames-cloud owns the read path.
//
// Writes are returned in the /run response body; the customer's CI appends
// them to events.ndjson and commits. No write path lives here.

import type { Source } from "@frames-ag/tick-types";
import { retry } from "./util/retry";

const FRAMES_CLOUD_BASE = "https://frames-cloud.workers.dev";

/**
 * Decomposes a github.com URL into the pieces frames-cloud's resolver needs.
 *
 *   https://github.com/microchipgnu/frames-examples
 *     → { user: "microchipgnu", repo: "frames-examples", frame_path: "", ref: "HEAD" }
 *
 *   https://github.com/microchipgnu/frames-examples/datasets/mcp-servers
 *     → { user: "microchipgnu", repo: "frames-examples", frame_path: "datasets/mcp-servers", ref: "HEAD" }
 *
 *   https://github.com/microchipgnu/frames-examples/datasets/mcp-servers?ref=v0.4
 *     → { ..., ref: "v0.4" }
 */
export function parseFrameUrl(url: string): {
  user: string;
  repo: string;
  frame_path: string;
  ref: string;
} {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:\/([^?#]*))?(?:\?(.*))?$/);
  if (!m) {
    throw new FrameClientError("invalid_frame_url", `Expected https://github.com/<user>/<repo>[/<path>], got: ${url}`);
  }
  const [, user = "", repo = "", path = "", query = ""] = m;
  const params = new URLSearchParams(query);
  return {
    user,
    repo,
    frame_path: path.replace(/\/$/, ""),
    ref: params.get("ref") ?? "HEAD",
  };
}

// ---------------------------------------------------------------------------
// Response shapes (mirror frames-cloud/src/app.ts response builders 1:1)
// ---------------------------------------------------------------------------

export interface FrameMeta {
  user: string;
  repo: string;
  sha: string;
  frame_path: string;
  schema_name: string;
  description?: string;
  entity_type?: string;
  entity_count: number;
  fields: string[];
  max_ts: string;
}

export interface FrameSchema {
  frame_protocol: string;
  name: string;
  description?: string;
  entity_type?: string;
  fields: Record<
    string,
    {
      type: "string" | "int" | "float" | "bool" | "date" | "url" | "enum";
      required?: boolean;
      values?: string[];
      description?: string;
    }
  >;
  tests?: unknown[];
  allow_unknown_fields?: boolean;
}

export interface EntityShape {
  entity_id: string;
  fields: Record<string, unknown>;
  /**
   * Per-field current fact_id. Present from frames-cloud >= 2026-05-11.
   * Required to emit `fact.deprecated` / `evidence.attached` events.
   * Older deployments may omit this — tick falls back to verify-only mode.
   */
  fact_ids?: Record<string, string>;
  /** Per-field evidence: { field: [primary_source, ...corroborating_sources] }. */
  evidence?: Record<string, Source[]>;
  /** Present only when entity is fetched with include=history. */
  history?: Record<string, Array<{ value: unknown; source: Source; ts: string }>>;
}

export interface EntitiesPage {
  data: EntityShape[];
  page: {
    limit: number;
    next_cursor: string | null;
    has_more: boolean;
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FrameClientError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
    this.name = "FrameClientError";
  }
}

export interface FrameClientOptions {
  /** Base URL of the frames-cloud resolver. Defaults to the public deployment. */
  base?: string;
  /** GitHub PAT (passed as a header to frames-cloud for private repo rate-limit bumps; post-alpha). */
  github_token?: string;
  /** ETag cache provided by the caller. Lets repeated reads short-circuit on 304. */
  etag_cache?: Map<string, { etag: string; body: string }>;
}

export class FrameClient {
  private base: string;
  private github_token?: string;
  private etag_cache?: Map<string, { etag: string; body: string }>;

  constructor(opts: FrameClientOptions = {}) {
    this.base = opts.base ?? FRAMES_CLOUD_BASE;
    this.github_token = opts.github_token;
    this.etag_cache = opts.etag_cache;
  }

  /** Frame metadata: schema name, entity count, max_ts, fields. */
  async getMeta(frame_url: string): Promise<FrameMeta> {
    const { user, repo, frame_path, ref } = parseFrameUrl(frame_url);
    const path = frame_path ? `/${user}/${repo}/${frame_path}` : `/${user}/${repo}`;
    return await this.request<FrameMeta>(path, ref);
  }

  /** Raw schema.yml (parsed) for the frame. */
  async getSchema(frame_url: string): Promise<FrameSchema> {
    const { user, repo, frame_path, ref } = parseFrameUrl(frame_url);
    const prefix = frame_path ? `${user}/${repo}/${frame_path}` : `${user}/${repo}`;
    return await this.request<FrameSchema>(`/${prefix}/schema`, ref);
  }

  /** README.md as a string. */
  async getReadme(frame_url: string): Promise<string> {
    const { user, repo, frame_path, ref } = parseFrameUrl(frame_url);
    const prefix = frame_path ? `${user}/${repo}/${frame_path}` : `${user}/${repo}`;
    const url = `${this.base}/api/v1/${prefix}/readme${ref !== "HEAD" ? `?ref=${ref}` : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new FrameClientError("http_error", `readme: ${res.status}`, res.status);
    return await res.text();
  }

  /**
   * Page of entities. include controls evidence depth:
   *   "first"   — first (primary) source per field
   *   "all"     — primary + corroborating sources
   *   "history" — full history per field (use sparingly; large response)
   */
  async listEntities(
    frame_url: string,
    opts: {
      cursor?: string;
      limit?: number;
      include?: "first" | "all" | "history";
      filters?: Record<string, string>;
    } = {},
  ): Promise<EntitiesPage> {
    const { user, repo, frame_path, ref } = parseFrameUrl(frame_url);
    const prefix = frame_path ? `${user}/${repo}/${frame_path}` : `${user}/${repo}`;
    const qs = new URLSearchParams();
    if (ref !== "HEAD") qs.set("ref", ref);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.include) qs.set("include", opts.include);
    for (const [k, v] of Object.entries(opts.filters ?? {})) qs.set(`filter[${k}]`, v);
    const tail = qs.toString();
    const url = `${this.base}/api/v1/${prefix}/entities${tail ? `?${tail}` : ""}`;
    return await this.requestUrl<EntitiesPage>(url);
  }

  /** All entities, auto-paginated. Yields pages until the cursor is exhausted. */
  async *iterateEntities(
    frame_url: string,
    opts: { limit?: number; include?: "first" | "all" | "history" } = {},
  ): AsyncIterable<EntityShape> {
    let cursor: string | undefined;
    do {
      const page = await this.listEntities(frame_url, { ...opts, cursor });
      for (const ent of page.data) yield ent;
      cursor = page.page.next_cursor ?? undefined;
    } while (cursor);
  }

  /** Single entity with fields + evidence. include defaults to "all". */
  async getEntity(
    frame_url: string,
    entity_id: string,
    include: "first" | "all" | "history" = "all",
  ): Promise<EntityShape | null> {
    const { user, repo, frame_path, ref } = parseFrameUrl(frame_url);
    const prefix = frame_path ? `${user}/${repo}/${frame_path}` : `${user}/${repo}`;
    const qs = new URLSearchParams();
    qs.set("include", include);
    if (ref !== "HEAD") qs.set("ref", ref);
    const url = `${this.base}/api/v1/${prefix}/entities/${entity_id}?${qs}`;
    try {
      return await this.requestUrl<EntityShape>(url);
    } catch (e) {
      if (e instanceof FrameClientError && e.status === 404) return null;
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async request<T>(apiPath: string, ref: string): Promise<T> {
    const refQs = ref !== "HEAD" ? `?ref=${ref}` : "";
    return await this.requestUrl<T>(`${this.base}/api/v1${apiPath}${refQs}`);
  }

  private async requestUrl<T>(url: string): Promise<T> {
    // Retry transient failures (5xx, network). 4xx fails fast.
    return await retry(async () => {
      const headers = this.headers();
      const cached = this.etag_cache?.get(url);
      if (cached) headers.set("If-None-Match", cached.etag);
      const res = await fetch(url, { headers });
      if (res.status === 304 && cached) {
        return JSON.parse(cached.body) as T;
      }
      if (!res.ok) {
        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {
          /* swallow */
        }
        throw new FrameClientError(`http_${res.status}`, `${url}: ${res.status} ${bodyText.slice(0, 200)}`, res.status);
      }
      const body = await res.text();
      const etag = res.headers.get("ETag");
      if (etag && this.etag_cache) this.etag_cache.set(url, { etag, body });
      return JSON.parse(body) as T;
    });
  }

  private headers(): Headers {
    const h = new Headers({ accept: "application/json" });
    if (this.github_token) h.set("x-github-token", this.github_token);
    return h;
  }
}
