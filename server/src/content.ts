import type { ToolDescriptor } from "./types.js";
import { descriptorId } from "./descriptor-id.js";

const DEFAULT_BASE =
  "https://raw.githubusercontent.com/microchipgnu/catalog/main/content";

export interface ContentSource {
  // Base URL pointing at the `content/` directory.
  // Tools live at `${baseUrl}/tools/<id>.json`.
  // Index lives at `${baseUrl}/index.ndjson`.
  baseUrl: string;
  // Optional GitHub token for higher rate limits if any code path falls
  // back to the GitHub API. Not required for raw.githubusercontent.com.
  githubToken?: string;
}

export const defaultContent: ContentSource = {
  baseUrl: DEFAULT_BASE,
};

export async function fetchDescriptor(
  source: ContentSource,
  id: string,
): Promise<{ descriptor: ToolDescriptor; descriptor_id: string } | null> {
  const url = `${source.baseUrl}/tools/${id}.json`;
  const res = await fetch(url);
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
  const url = `${source.baseUrl}/index.ndjson`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch index ${url}: ${res.status}`);
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as ToolDescriptor);
}
