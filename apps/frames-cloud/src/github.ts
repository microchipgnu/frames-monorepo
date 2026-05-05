const GITHUB_API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gh(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": "frames-cloud",
    Accept: "application/vnd.github+json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${GITHUB_API}${path}`, { headers });
}

export async function resolveSha(
  user: string,
  repo: string,
  ref: string = "HEAD",
  token?: string,
): Promise<string> {
  const res = await gh(`/repos/${user}/${repo}/commits/${ref}`, token);
  if (res.status === 404) throw new GitHubError(404, `repo not found: ${user}/${repo}`);
  if (!res.ok) throw new GitHubError(res.status, `github: ${res.status}`);
  const json = (await res.json()) as { sha: string };
  return json.sha;
}

export async function fetchRaw(
  user: string,
  repo: string,
  sha: string,
  path: string,
): Promise<string | null> {
  const url = `${RAW}/${user}/${repo}/${sha}/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": "frames-cloud" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(res.status, `raw fetch failed: ${path}`);
  return res.text();
}

export type FrameTreeEntry = {
  /** path to the frame directory, "" for repo root, e.g. "datasets/foo" */
  frame_path: string;
  /** path to the schema file relative to repo root */
  schema_path: string;
};

export async function discoverFrames(
  user: string,
  repo: string,
  sha: string,
  token?: string,
): Promise<FrameTreeEntry[]> {
  const res = await gh(`/repos/${user}/${repo}/git/trees/${sha}?recursive=1`, token);
  if (res.status === 404) throw new GitHubError(404, `tree not found: ${user}/${repo}@${sha}`);
  if (!res.ok) throw new GitHubError(res.status, `github tree: ${res.status}`);
  const json = (await res.json()) as {
    tree: Array<{ path: string; type: "blob" | "tree" }>;
    truncated?: boolean;
  };
  const frames: FrameTreeEntry[] = [];
  for (const entry of json.tree) {
    if (entry.type !== "blob") continue;
    if (entry.path === "schema.yml") {
      frames.push({ frame_path: "", schema_path: "schema.yml" });
    } else if (entry.path.endsWith("/schema.yml")) {
      const dir = entry.path.slice(0, -"/schema.yml".length);
      frames.push({ frame_path: dir, schema_path: entry.path });
    }
  }
  return frames;
}
