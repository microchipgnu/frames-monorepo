// HTTP catalog client. Talks to any catalog server speaking the
// pay/SPEC.md catalog HTTP shape (catalog.frames.ag is the canonical one).

import type {
  CatalogSource,
  CatalogListResponse,
  ToolDescriptor,
} from "../types.ts";

export interface HttpCatalogConfig {
  /** Base URL of the catalog server, e.g. "https://catalog.frames.ag". */
  baseUrl: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class HttpCatalog implements CatalogSource {
  readonly id: string;
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(config: HttpCatalogConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.id = this.baseUrl;
    this.fetch = config.fetchImpl ?? fetch;
  }

  async list(filter?: {
    capability?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ tools: ToolDescriptor[]; cursor?: string | null }> {
    const params = new URLSearchParams();
    if (filter?.capability) params.set("capability", filter.capability);
    if (filter?.q) params.set("q", filter.q);
    if (filter?.cursor) params.set("cursor", filter.cursor);
    if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
    const qs = params.toString();
    const url = `${this.baseUrl}/catalog${qs ? "?" + qs : ""}`;
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new Error(`Catalog list failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as CatalogListResponse;
    return { tools: body.tools, cursor: body.cursor ?? null };
  }

  async get(toolId: string): Promise<ToolDescriptor | null> {
    const url = `${this.baseUrl}/tools/${encodeURIComponent(toolId)}`;
    const res = await this.fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Catalog get failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ToolDescriptor;
  }

  /**
   * Fetch a descriptor and the server-reported descriptor_id (from
   * X-Descriptor-Id header). Useful when the caller wants to verify
   * the server's hash matches their own computation without re-running
   * canonicalization themselves.
   */
  async getWithServerId(
    toolId: string,
  ): Promise<
    { descriptor: ToolDescriptor; server_descriptor_id: string | null } | null
  > {
    const url = `${this.baseUrl}/tools/${encodeURIComponent(toolId)}`;
    const res = await this.fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Catalog get failed: ${res.status} ${res.statusText}`);
    }
    const descriptor = (await res.json()) as ToolDescriptor;
    const xDesc = res.headers.get("x-descriptor-id");
    const etagFallback = (res.headers.get("etag") ?? "").replace(
      /^W\/"|"$/g,
      "",
    );
    const server_descriptor_id = xDesc ?? (etagFallback || null);
    return { descriptor, server_descriptor_id };
  }
}
