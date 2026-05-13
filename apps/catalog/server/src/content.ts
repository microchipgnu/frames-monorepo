import type { MerchantEntity, ToolDescriptor } from "./types.js";
import { descriptorId } from "./descriptor-id.js";

// Reads catalog content from the monorepo's apps/catalog/content/ path on
// main. raw.githubusercontent.com accepts `Authorization: Bearer <token>` for
// private repos when the PAT has Contents:read scope. Token is supplied via
// the Worker secret GITHUB_TOKEN (`wrangler secret put GITHUB_TOKEN`).
//
// To switch to a public source (e.g. mirror repo) just rewrite this URL and
// unset the secret.
const DEFAULT_BASE =
  "https://raw.githubusercontent.com/microchipgnu/frames-monorepo/main/apps/catalog/content";

export interface ContentSource {
  // Base URL pointing at the `content/` directory.
  // Tools live at `${baseUrl}/tools/<id>.json`.
  // Index lives at `${baseUrl}/index.ndjson`.
  baseUrl: string;
  // GitHub token. REQUIRED when baseUrl is a private repo's raw URL.
  // Optional for public repos (raises rate limit ceiling).
  githubToken?: string;
}

export const defaultContent: ContentSource = {
  baseUrl: DEFAULT_BASE,
};

function authHeaders(source: ContentSource): Record<string, string> {
  return source.githubToken
    ? { Authorization: `Bearer ${source.githubToken}` }
    : {};
}

export async function fetchDescriptor(
  source: ContentSource,
  id: string,
): Promise<{ descriptor: ToolDescriptor; descriptor_id: string } | null> {
  const url = `${source.baseUrl}/tools/${id}.json`;
  const res = await fetch(url, { headers: authHeaders(source) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const descriptor = (await res.json()) as ToolDescriptor;
  const id_ = await descriptorId(descriptor);
  return { descriptor, descriptor_id: id_ };
}

export async function fetchIndex(
  source: ContentSource,
): Promise<ToolDescriptor[]> {
  return fetchNdjsonIndex(source, "index.ndjson");
}

export async function fetchLongTailIndex(
  source: ContentSource,
): Promise<ToolDescriptor[]> {
  return fetchNdjsonIndex(source, "index-longtail.ndjson");
}

async function fetchNdjsonIndex(
  source: ContentSource,
  path: string,
): Promise<ToolDescriptor[]> {
  const url = `${source.baseUrl}/${path}`;
  const res = await fetch(url, { headers: authHeaders(source) });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as ToolDescriptor);
}

export async function fetchMerchant(
  source: ContentSource,
  host: string,
): Promise<MerchantEntity | null> {
  const url = `${source.baseUrl}/merchants/${host}.json`;
  const res = await fetch(url, { headers: authHeaders(source) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return (await res.json()) as MerchantEntity;
}

export async function fetchMerchantIndex(
  source: ContentSource,
): Promise<MerchantEntity[]> {
  const url = `${source.baseUrl}/merchants.ndjson`;
  const res = await fetch(url, { headers: authHeaders(source) });
  if (res.status === 404) return []; // pre-projection state — graceful empty
  if (!res.ok) {
    throw new Error(`Failed to fetch merchant index ${url}: ${res.status}`);
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as MerchantEntity);
}

export interface RefreshMeta {
  refreshed_at: string;
  total_ms: number;
  sources: {
    name: string;
    status: "ok" | "fail";
    ms: number;
    err?: string;
    output_bytes?: number;
  }[];
}

export async function fetchRefreshMeta(
  source: ContentSource,
): Promise<RefreshMeta | null> {
  const url = `${source.baseUrl}/refresh-meta.json`;
  const res = await fetch(url, { headers: authHeaders(source) });
  if (!res.ok) return null;
  return (await res.json()) as RefreshMeta;
}
