import type { ToolDescriptor } from "./types.js";
import { descriptorId } from "./descriptor-id.js";

const DEFAULT_BASE =
  "https://raw.githubusercontent.com/microchipgnu/catalog/main/content/tools";
const DEFAULT_INDEX =
  "https://api.github.com/repos/microchipgnu/catalog/contents/content/tools?ref=main";

export interface ContentSource {
  baseUrl: string;
  indexUrl: string;
  // Optional GitHub token for higher rate limits when listing.
  githubToken?: string;
}

export const defaultContent: ContentSource = {
  baseUrl: DEFAULT_BASE,
  indexUrl: DEFAULT_INDEX,
};

export async function fetchDescriptor(
  source: ContentSource,
  id: string,
): Promise<{ descriptor: ToolDescriptor; descriptor_id: string } | null> {
  const url = `${source.baseUrl}/${id}.json`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const descriptor = (await res.json()) as ToolDescriptor;
  const id_ = await descriptorId(descriptor);
  return { descriptor, descriptor_id: id_ };
}

export async function listDescriptorIds(
  source: ContentSource,
): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (source.githubToken) {
    headers.Authorization = `Bearer ${source.githubToken}`;
  }
  const res = await fetch(source.indexUrl, { headers });
  if (!res.ok) {
    throw new Error(`Failed to list content: ${res.status}`);
  }
  const items = (await res.json()) as Array<{ name: string; type: string }>;
  return items
    .filter((i) => i.type === "file" && i.name.endsWith(".json"))
    .map((i) => i.name.slice(0, -".json".length));
}
