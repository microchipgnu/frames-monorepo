#!/usr/bin/env bun
// Scrape skills.sh top lists → resolve each skill's path inside its GitHub repo.
//
// Output (stdout, JSON array of):
//   { owner, repo, skill_name, skill_path, install_count, install_count_str,
//     ranks: { all_time?, trending?, hot? } }
//
// Description is intentionally not fetched here — skills.sh meta tags are
// boilerplate ("Install the X skill for your AI agent."). The real description
// lives in SKILL.md frontmatter; scan.ts gets it for free from agentsec's
// `manifest.description`.
//
// Pure HTTP + regex. No external dependencies.
//
// GitHub Tree API is rate-limited at 60/hr unauth, 5000/hr with token. Pass
// GITHUB_TOKEN in env (the GH Actions runner provides it automatically).

const TOP_N = 50;

const LISTS = [
  { url: "https://skills.sh/", source: "all_time" as const },
  { url: "https://skills.sh/trending", source: "trending" as const },
  { url: "https://skills.sh/hot", source: "hot" as const },
];

type Source = "all_time" | "trending" | "hot";

type Card = {
  owner: string;
  repo: string;
  skill_name: string;
  install_count_str: string;
  install_count: number;
};

type Entry = Card & {
  skill_path?: string;
  ranks: Partial<Record<Source, number>>;
};

const UA = "skill-watch-bot (+https://github.com/microchipgnu/skill-watch)";

function parseInstallCount(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([kKmMbB]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  const mult = suf === "b" ? 1e9 : suf === "m" ? 1e6 : suf === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

// Cards on skills.sh look like:
//   <a class="group grid ... h-full" href="/<owner>/<repo>/<skill>">
//     ...<span>RANK</span>...<h3>NAME</h3>...<p>OWNER/REPO</p>...<span>INSTALLS</span>...
//   </a>
// We rely on the (very specific) class signature `class="group ... h-full"` which
// uniquely identifies the row anchors and not the nav links.
function parseCards(html: string): Card[] {
  const cards: Card[] = [];
  const cardRe = /<a class="group[^"]*h-full"\s+href="\/([^/"]+)\/([^/"]+)\/([^/"]+)">([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(cardRe)) {
    const [, owner, repo, skill_name, body] = m;
    // Last <span> in the card body is the install-count display ("1.4M" / "12k" / "456")
    const spans = [...body.matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const installStr = spans[spans.length - 1] ?? "0";
    cards.push({
      owner,
      repo,
      skill_name,
      install_count_str: installStr,
      install_count: parseInstallCount(installStr),
    });
  }
  return cards;
}

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

async function ghJson(path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": UA,
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`GH ${path} → ${r.status}`);
  return r.json();
}

type TreeEntry = { path: string; type: "blob" | "tree" };

// Walk a repo's full tree to find the SKILL.md whose containing folder
// matches the skills.sh URL slug. The slug isn't always exactly the folder
// name — skills.sh sometimes adds an owner-ish prefix (e.g. URL slug
// `vercel-react-best-practices` lives at `skills/react-best-practices/`).
//
// Match strategy:
//   1. Exact folder name match
//   2. Folder name is a suffix of the slug (slug carries an extra prefix)
//   3. Slug is a suffix of the folder name (extra noise dropped from slug)
//
// We collect every SKILL.md path in the tree and score the candidates,
// returning the best match (longest folder name) or null.
function resolveSkillPath(tree: TreeEntry[], skill_name: string): string | null {
  const target = skill_name.toLowerCase();
  const candidates: { folder: string; path: string }[] = [];
  for (const e of tree) {
    if (e.type !== "blob") continue;
    const parts = e.path.split("/");
    if (parts[parts.length - 1].toLowerCase() !== "skill.md") continue;
    if (parts.length < 2) continue;
    candidates.push({ folder: parts[parts.length - 2].toLowerCase(), path: parts.slice(0, -1).join("/") });
  }
  // 1. Exact match wins outright.
  const exact = candidates.find((c) => c.folder === target);
  if (exact) return exact.path;
  // 2 & 3. Suffix-match either way; pick the longest folder name (most specific).
  const suffix = candidates
    .filter((c) => target.endsWith("-" + c.folder) || c.folder.endsWith("-" + target))
    .sort((a, b) => b.folder.length - a.folder.length);
  return suffix[0]?.path ?? null;
}

async function fetchTree(owner: string, repo: string, token?: string): Promise<TreeEntry[] | null> {
  try {
    // /HEAD redirects to the default branch
    const r = await ghJson(`/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, token);
    if (r.truncated) console.error(`! tree truncated for ${owner}/${repo}`);
    return r.tree as TreeEntry[];
  } catch (e) {
    console.error(`! could not fetch tree for ${owner}/${repo}: ${e}`);
    return null;
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;

  // 1. Scrape each list page; merge ranks per (owner/repo/skill_name) key.
  const merged = new Map<string, Entry>();
  for (const { url, source } of LISTS) {
    const html = await fetchHtml(url);
    const cards = parseCards(html).slice(0, TOP_N);
    cards.forEach((c, i) => {
      const key = `${c.owner}/${c.repo}/${c.skill_name}`;
      const cur = merged.get(key) ?? { ...c, ranks: {} };
      cur.ranks[source] = i + 1;
      // Keep the freshest install_count we saw
      if (c.install_count > cur.install_count) {
        cur.install_count = c.install_count;
        cur.install_count_str = c.install_count_str;
      }
      merged.set(key, cur);
    });
    console.error(`◇ ${source}: ${cards.length} cards (top ${TOP_N})`);
  }

  const entries = [...merged.values()];
  console.error(`◇ ${entries.length} unique skills across the three lists`);

  // 2. Resolve skill_path per unique repo (single tree fetch each).
  const repos = new Set(entries.map((e) => `${e.owner}/${e.repo}`));
  console.error(`◇ resolving paths in ${repos.size} unique repos`);
  const trees = new Map<string, TreeEntry[] | null>();
  for (const slug of repos) {
    const [o, r] = slug.split("/");
    trees.set(slug, await fetchTree(o, r, token));
  }

  for (const e of entries) {
    const tree = trees.get(`${e.owner}/${e.repo}`);
    if (tree) e.skill_path = resolveSkillPath(tree, e.skill_name) ?? undefined;
  }

  // 3. Drop unresolvable (no SKILL.md found at the expected nesting).
  const unresolvable = entries.filter((e) => !e.skill_path);
  if (unresolvable.length) {
    console.error(`! ${unresolvable.length} unresolvable: ${unresolvable.slice(0, 5).map((e) => `${e.owner}/${e.repo}/${e.skill_name}`).join(", ")}${unresolvable.length > 5 ? ", …" : ""}`);
  }
  const resolved = entries.filter((e) => e.skill_path);

  // 4. Emit.
  console.error(`✓ ${resolved.length} skills ready`);
  process.stdout.write(JSON.stringify(resolved, null, 2) + "\n");
}

main().catch((e) => {
  console.error("scrape failed:", e);
  process.exit(1);
});
