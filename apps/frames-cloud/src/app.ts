import { Hono } from "hono";
import { cors } from "hono/cors";
import { DatasetError, cacheStats, listFrames, loadDataset } from "./cache";
import { GitHubError } from "./github";
import { decodeCursor, paginate, parseFilters } from "./pagination";
import type { Dataset, Entity, RecentActivity, Source } from "./types";
import { renderEntity, renderFrame, renderHome, renderRepoIndex } from "./views";

const app = new Hono();
app.use("*", cors());

const RESOURCE_WORDS = new Set(["schema", "readme", "entities", "_frames"]);

// ---------------------------------------------------------------------------
// 1. Static endpoints
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const user = "microchipgnu";
  const repo = "frames-examples";
  let data: Parameters<typeof renderHome>[0] = null;
  try {
    const { sha, frames } = await listFrames(user, repo, "HEAD");
    const summaries = await Promise.all(
      frames.map(async (f) => {
        try {
          const ds = await loadDataset(user, repo, "HEAD", f.frame_path);
          return {
            frame_path: f.frame_path,
            schema_name: ds.schema.name,
            description: ds.schema.description,
            entity_count: [...ds.entities.values()].filter((e) => !e.removed).length,
            max_ts: ds.max_ts,
          };
        } catch {
          return { frame_path: f.frame_path };
        }
      }),
    );
    data = { user, repo, sha, frames: summaries };
  } catch {
    data = null;
  }
  c.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  return c.html(renderHome(data));
});
app.get("/healthz", (c) => c.json({ ok: true, cache: cacheStats() }));

// ---------------------------------------------------------------------------
// 2. JSON API at /api/v1/* (registered BEFORE the HTML catch-all so it wins)
// ---------------------------------------------------------------------------

const v1 = new Hono();

function withETag(c: any, sha: string, max_ts: string, suffix = "") {
  const etag = `W/"${sha.slice(0, 12)}-${max_ts}${suffix ? "-" + suffix : ""}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  if (c.req.header("If-None-Match") === etag) {
    c.status(304);
    return true;
  }
  return false;
}

function computeRecent(ds: Dataset, limit: number): RecentActivity[] {
  const acts: RecentActivity[] = [];
  for (const ent of ds.entities.values()) {
    if (ent.removed) continue;
    const allFacts = Object.values(ent.history).flat();
    if (allFacts.length === 0) continue;
    let firstSeen = allFacts[0]!.ts;
    for (const f of allFacts) if (f.ts < firstSeen) firstSeen = f.ts;
    const name = String(ent.fields.name ?? ent.entity_id);
    acts.push({
      type: "created",
      entity_id: ent.entity_id,
      entity_name: name,
      ts: firstSeen,
    });
    // An "update" is a fact that supersedes a prior fact for the same field.
    // The first fact per field is the initial set, conceptually part of "created".
    for (const facts of Object.values(ent.history)) {
      const sorted = facts.slice().sort((a, b) => a.ts.localeCompare(b.ts));
      for (let i = 1; i < sorted.length; i++) {
        const f = sorted[i]!;
        acts.push({
          type: "updated",
          entity_id: ent.entity_id,
          entity_name: name,
          field: f.field,
          value: f.value,
          previous: sorted[i - 1]!.value,
          ts: f.ts,
          source: f.source,
        });
      }
    }
  }
  acts.sort((a, b) => b.ts.localeCompare(a.ts));
  return acts.slice(0, limit);
}

function entityShape(ent: Entity, include: "first" | "all" | "history") {
  if (include === "history") {
    const history: Record<string, Array<{
      fact_id: string;
      value: unknown;
      ts: string;
      source: Source;
      evidence: Source[];
      deprecated: boolean;
      current: boolean;
      confidence?: number;
      observed_at?: string;
    }>> = {};
    for (const [field, facts] of Object.entries(ent.history)) {
      const liveId = ent.facts[field]?.fact_id;
      history[field] = facts
        .slice()
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .map((f) => ({
          fact_id: f.fact_id,
          value: f.value,
          ts: f.ts,
          source: f.source,
          evidence: f.evidence,
          deprecated: f.deprecated,
          current: f.fact_id === liveId,
          confidence: f.confidence,
          observed_at: f.observed_at,
        }));
    }
    return { entity_id: ent.entity_id, fields: ent.fields, history };
  }
  const evidence: Record<string, Source | Source[]> = {};
  if (include === "first") {
    for (const [field, src] of Object.entries(ent.evidence)) evidence[field] = src;
  } else {
    for (const [field, fact] of Object.entries(ent.facts)) {
      evidence[field] = [fact.source, ...fact.evidence];
    }
  }
  return { entity_id: ent.entity_id, fields: ent.fields, evidence };
}

v1.get("/:user/:repo/_frames", async (c) => {
  const { user, repo } = c.req.param();
  const ref = c.req.query("ref") ?? "HEAD";
  const { sha, frames } = await listFrames(user, repo, ref);
  if (withETag(c, sha, "frames")) return c.body(null);
  const enriched = await Promise.all(
    frames.map(async (f) => {
      try {
        const ds = await loadDataset(user, repo, ref, f.frame_path);
        return {
          slug: f.frame_path || ".",
          frame_path: f.frame_path,
          schema_name: ds.schema.name,
          description: ds.schema.description,
          entity_type: ds.schema.entity_type,
          entity_count: [...ds.entities.values()].filter((e) => !e.removed).length,
          max_ts: ds.max_ts,
          fields: Object.keys(ds.schema.fields),
        };
      } catch {
        return { slug: f.frame_path || ".", frame_path: f.frame_path, error: "load failed" };
      }
    }),
  );
  return c.json({ user, repo, sha, frames: enriched });
});

v1.get("/:user/:repo", async (c) => {
  const { user, repo } = c.req.param();
  const ref = c.req.query("ref") ?? "HEAD";
  try {
    return await respondMeta(c, user, repo, "", ref);
  } catch (e) {
    // No root schema.yml → return the repo's frame index instead.
    if (e instanceof DatasetError && e.status === 422) {
      const { sha, frames } = await listFrames(user, repo, ref);
      if (frames.length === 0) throw e;
      return c.json({ user, repo, sha, frames: frames.map((f) => ({ frame_path: f.frame_path })) });
    }
    throw e;
  }
});

v1.get("/:user/:repo/*", async (c) => {
  const { user, repo } = c.req.param();
  const prefix = `/api/v1/${user}/${repo}/`;
  const idx = c.req.path.indexOf(prefix);
  const rest = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  const ref = c.req.query("ref") ?? "HEAD";
  const segments = rest.split("/").filter(Boolean);

  const resourceIdx = segments.findIndex((s: string) => RESOURCE_WORDS.has(s));
  const framePath =
    resourceIdx === -1 ? segments.join("/") : segments.slice(0, resourceIdx).join("/");
  const resource = resourceIdx === -1 ? null : segments[resourceIdx]!;
  const tail = resourceIdx === -1 ? [] : segments.slice(resourceIdx + 1);

  if (resource === null) return respondMeta(c, user, repo, framePath, ref);
  switch (resource) {
    case "schema":
      return respondSchema(c, user, repo, framePath, ref);
    case "readme":
      return respondReadme(c, user, repo, framePath, ref);
    case "entities":
      if (tail.length === 0) return respondEntities(c, user, repo, framePath, ref);
      if (tail.length === 1) return respondEntity(c, user, repo, framePath, ref, tail[0]!);
      return c.json({ error: "bad entities subpath" }, 400);
    default:
      return c.json({ error: `unknown resource: ${resource}` }, 404);
  }
});

async function respondMeta(c: any, user: string, repo: string, framePath: string, ref: string) {
  const ds = await loadDataset(user, repo, ref, framePath);
  const url = new URL(c.req.url);
  const recentParam = url.searchParams.get("recent");
  const recentLimit = recentParam !== null ? Math.max(1, Math.min(100, parseInt(recentParam, 10) || 10)) : 0;
  if (withETag(c, ds.sha, ds.max_ts, `${framePath}-r${recentLimit}`)) return c.body(null);
  return c.json({
    user: ds.user,
    repo: ds.repo,
    sha: ds.sha,
    frame_path: ds.frame_path,
    schema_name: ds.schema.name,
    description: ds.schema.description,
    entity_type: ds.schema.entity_type,
    entity_count: [...ds.entities.values()].filter((e) => !e.removed).length,
    fields: Object.keys(ds.schema.fields),
    max_ts: ds.max_ts,
    ...(recentLimit > 0 ? { recent: computeRecent(ds, recentLimit) } : {}),
  });
}

async function respondSchema(c: any, user: string, repo: string, framePath: string, ref: string) {
  const ds = await loadDataset(user, repo, ref, framePath);
  if (withETag(c, ds.sha, ds.max_ts, framePath)) return c.body(null);
  return c.json(ds.schema);
}

async function respondReadme(c: any, user: string, repo: string, framePath: string, ref: string) {
  const ds = await loadDataset(user, repo, ref, framePath);
  if (withETag(c, ds.sha, ds.max_ts, framePath)) return c.body(null);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(ds.readme);
}

async function respondEntities(c: any, user: string, repo: string, framePath: string, ref: string) {
  const ds = await loadDataset(user, repo, ref, framePath);
  if (withETag(c, ds.sha, ds.max_ts, framePath)) return c.body(null);
  const url = new URL(c.req.url);
  const limit = Math.max(
    1,
    Math.min(1000, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const cursor = decodeCursor(url.searchParams.get("cursor") ?? undefined);
  const filters = parseFilters(url.searchParams);
  const includeRaw = url.searchParams.get("include");
  const include: "first" | "all" | "history" =
    includeRaw === "all" ? "all" : includeRaw === "history" ? "history" : "first";
  const { rows, next_cursor, has_more } = paginate(ds.entities.values(), cursor, limit, filters);
  if (next_cursor) {
    const nextUrl = new URL(c.req.url);
    nextUrl.searchParams.set("cursor", next_cursor);
    c.header("Link", `<${nextUrl.toString()}>; rel="next"`);
  }
  return c.json({
    data: rows.map((e) => entityShape(e, include)),
    page: { limit, next_cursor, has_more },
  });
}

async function respondEntity(
  c: any,
  user: string,
  repo: string,
  framePath: string,
  ref: string,
  id: string,
) {
  const ds = await loadDataset(user, repo, ref, framePath);
  if (withETag(c, ds.sha, ds.max_ts, framePath)) return c.body(null);
  const ent = ds.entities.get(id);
  if (!ent || ent.removed) {
    return c.json({ error: "entity not found", entity_id: id }, 404);
  }
  const includeRaw = c.req.query("include");
  const include: "first" | "all" | "history" =
    includeRaw === "first" ? "first" : includeRaw === "history" ? "history" : "all";
  return c.json(entityShape(ent, include));
}

app.route("/api/v1", v1);

// ---------------------------------------------------------------------------
// 3. HTML catch-all at /:user/:repo/* (after the API mount, so it doesn't
//    intercept /api/v1/...)
// ---------------------------------------------------------------------------

async function htmlFrameOrEntity(c: any) {
  const { user, repo } = c.req.param();
  const path = c.req.path;
  const prefix = `/${user}/${repo}`;
  const rest = path === prefix ? "" : path.slice(prefix.length + 1);
  const ref = c.req.query("ref") ?? "HEAD";
  const segments = rest.split("/").filter(Boolean);

  const resourceIdx = segments.findIndex((s: string) => RESOURCE_WORDS.has(s));
  const framePath =
    resourceIdx === -1 ? segments.join("/") : segments.slice(0, resourceIdx).join("/");
  const resource = resourceIdx === -1 ? null : segments[resourceIdx]!;
  const tail = resourceIdx === -1 ? [] : segments.slice(resourceIdx + 1);

  if (resource === "entities" && tail.length === 1) {
    const ds = await loadDataset(user, repo, ref, framePath);
    const ent = ds.entities.get(tail[0]!);
    if (!ent || ent.removed) return c.html("<h1>not found</h1>", 404);
    return c.html(renderEntity(ds, ent));
  }

  let ds;
  try {
    ds = await loadDataset(user, repo, ref, framePath);
  } catch (e) {
    // Multi-frame repo with no schema.yml at the requested path: render index.
    if (e instanceof DatasetError && e.status === 422 && framePath === "") {
      const { sha, frames } = await listFrames(user, repo, ref);
      if (frames.length === 0) throw e;
      const summaries = await Promise.all(
        frames.map(async (f) => {
          try {
            const fds = await loadDataset(user, repo, ref, f.frame_path);
            return {
              slug: f.frame_path || ".",
              frame_path: f.frame_path,
              schema_name: fds.schema.name,
              description: fds.schema.description,
              entity_count: [...fds.entities.values()].filter((x) => !x.removed).length,
              max_ts: fds.max_ts,
            };
          } catch {
            return { slug: f.frame_path || ".", frame_path: f.frame_path, error: "load failed" };
          }
        }),
      );
      return c.html(renderRepoIndex(user, repo, sha, summaries));
    }
    throw e;
  }
  const url = new URL(c.req.url);
  const limit = Math.max(
    1,
    Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const cursor = decodeCursor(url.searchParams.get("cursor") ?? undefined);
  const filters = parseFilters(url.searchParams);
  const page = paginate(ds.entities.values(), cursor, limit, filters);

  const counts = new Map<string, number>();
  for (const e of ds.entities.values()) {
    if (e.removed) continue;
    const v = e.fields.hq_country;
    if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const recent = computeRecent(ds, 10);
  return c.html(renderFrame(ds, page.rows, page, filters, counts, recent));
}

app.get("/:user/:repo", htmlFrameOrEntity);
app.get("/:user/:repo/*", htmlFrameOrEntity);

// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof DatasetError) {
    return c.json({ error: err.message }, err.status as 422 | 404);
  }
  if (err instanceof GitHubError) {
    return c.json({ error: err.message }, err.status as 404 | 502);
  }
  console.error(err);
  return c.json({ error: "internal error", message: err.message }, 500);
});

export default app;
export { app };
