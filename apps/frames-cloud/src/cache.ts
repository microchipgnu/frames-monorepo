import { parse as parseYaml } from "yaml";
import { discoverFrames, fetchRaw, resolveSha, type FrameTreeEntry } from "./github";
import { parseEvents, project } from "./projector";
import type { Dataset, Schema } from "./types";

const SHA_TTL_MS = 60_000;
const shaCache = new Map<string, { sha: string; expires: number }>();
const framesCache = new Map<string, FrameTreeEntry[]>();
const datasetCache = new Map<string, Dataset>();

function shaKey(user: string, repo: string, ref: string) {
  return `${user.toLowerCase()}/${repo.toLowerCase()}@${ref}`;
}

function repoKey(user: string, repo: string, sha: string) {
  return `${user.toLowerCase()}/${repo.toLowerCase()}#${sha}`;
}

function dsKey(user: string, repo: string, sha: string, framePath: string) {
  return `${user.toLowerCase()}/${repo.toLowerCase()}#${sha}::${framePath}`;
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export async function resolveCachedSha(
  user: string,
  repo: string,
  ref = "HEAD",
  token?: string,
): Promise<string> {
  const key = shaKey(user, repo, ref);
  const cached = shaCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.sha;
  const sha = await resolveSha(user, repo, ref, token);
  shaCache.set(key, { sha, expires: Date.now() + SHA_TTL_MS });
  return sha;
}

export async function listFrames(
  user: string,
  repo: string,
  ref = "HEAD",
  token?: string,
): Promise<{ sha: string; frames: FrameTreeEntry[] }> {
  const sha = await resolveCachedSha(user, repo, ref, token);
  const key = repoKey(user, repo, sha);
  let frames = framesCache.get(key);
  if (!frames) {
    frames = await discoverFrames(user, repo, sha, token);
    framesCache.set(key, frames);
  }
  return { sha, frames };
}

export class DatasetError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function loadDataset(
  user: string,
  repo: string,
  ref = "HEAD",
  framePath = "",
  token?: string,
): Promise<Dataset> {
  const sha = await resolveCachedSha(user, repo, ref, token);
  const key = dsKey(user, repo, sha, framePath);
  const cached = datasetCache.get(key);
  if (cached) return cached;

  const [schemaText, eventsText, readmeText] = await Promise.all([
    fetchRaw(user, repo, sha, joinPath(framePath, "schema.yml"), token),
    fetchRaw(user, repo, sha, joinPath(framePath, "events.ndjson"), token),
    fetchRaw(user, repo, sha, joinPath(framePath, "README.md"), token),
  ]);

  if (!schemaText) {
    const where = framePath ? `${framePath}/` : "";
    throw new DatasetError(
      422,
      `not a frame: no schema.yml at ${user}/${repo}/${where}`,
    );
  }

  let schema: Schema;
  try {
    schema = parseYaml(schemaText) as Schema;
  } catch (e) {
    throw new DatasetError(422, `invalid schema.yml: ${(e as Error).message}`);
  }

  const events = parseEvents(eventsText ?? "");
  const { entities, max_ts } = project(events);

  const dataset: Dataset = {
    user,
    repo,
    sha,
    frame_path: framePath,
    schema,
    readme: readmeText ?? "",
    entities,
    max_ts,
  };
  datasetCache.set(key, dataset);
  return dataset;
}

export function cacheStats() {
  return {
    sha_cache: shaCache.size,
    frames_cache: framesCache.size,
    dataset_cache: datasetCache.size,
  };
}
