import { Hono } from "hono";
import type { CatalogCache } from "./cache.js";
import type { ContentSource } from "./content.js";
import { fetchDescriptor, fetchIndex } from "./content.js";
import type { ListResponse, ToolDescriptor } from "./types.js";

export interface HandlerDeps {
  cache: CatalogCache;
  content: ContentSource;
  webhookSecret?: string;
}

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=600";
const PAY_PROTOCOL = "0.0.1";

export function createHandler(deps: HandlerDeps) {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({ name: "catalog", spec: `pay ${PAY_PROTOCOL}` }),
  );

  app.get("/tools/:id", async (c) => {
    const id = c.req.param("id");
    const cacheKey = `tools:${id}`;
    const ifNoneMatch = c.req.header("if-none-match");

    let entry = await deps.cache.get(cacheKey);
    if (!entry) {
      const fetched = await fetchDescriptor(deps.content, id);
      if (!fetched) {
        return c.json({ error: { code: "NotFound" } }, 404);
      }
      entry = {
        etag: fetched.descriptor_id,
        body: JSON.stringify(fetched.descriptor),
        contentType: "application/json",
      };
      await deps.cache.set(cacheKey, entry, 60);
    }

    if (ifNoneMatch === entry.etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: entry.etag, "Cache-Control": CACHE_CONTROL },
      });
    }

    return new Response(entry.body, {
      headers: {
        "Content-Type": entry.contentType,
        ETag: entry.etag,
        "Cache-Control": CACHE_CONTROL,
      },
    });
  });

  app.get("/catalog/:id", async (c) => {
    const id = c.req.param("id");
    const fetched = await fetchDescriptor(deps.content, id);
    if (!fetched) {
      return c.json({ error: { code: "NotFound" } }, 404);
    }
    c.header("ETag", fetched.descriptor_id);
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json({
      pay_protocol: PAY_PROTOCOL,
      tool: fetched.descriptor,
      descriptor_id: fetched.descriptor_id,
    });
  });

  app.get("/catalog", async (c) => {
    const capability = c.req.query("capability");
    const q = c.req.query("q")?.trim().toLowerCase();
    const cursor = c.req.query("cursor");
    const limit = clamp(
      parseInt(c.req.query("limit") ?? "100", 10) || 100,
      1,
      500,
    );

    // Read the index (one HTTP fetch, cached in KV).
    const cacheKey = "index";
    let cached = await deps.cache.get(cacheKey);
    let index: ToolDescriptor[];
    if (cached) {
      index = JSON.parse(cached.body) as ToolDescriptor[];
    } else {
      index = await fetchIndex(deps.content);
      await deps.cache.set(
        cacheKey,
        {
          etag: `W/"index-${index.length}"`,
          body: JSON.stringify(index),
          contentType: "application/json",
        },
        60,
      );
    }

    let filtered = index;
    if (capability) {
      filtered = filtered.filter((t) => t.capabilities.includes(capability));
    }
    if (q) {
      // Substring match across id + title + description (case-insensitive).
      filtered = filtered.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
    }

    let startIdx = 0;
    if (cursor) {
      startIdx = filtered.findIndex((t) => t.id > cursor);
      if (startIdx === -1) startIdx = filtered.length;
    }

    const page = filtered.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < filtered.length;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null;

    const body: ListResponse = {
      pay_protocol: PAY_PROTOCOL,
      tools: page,
      cursor: nextCursor,
    };
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(body);
  });

  app.post("/webhooks/invalidate", async (c) => {
    if (deps.webhookSecret) {
      const sig = c.req.header("x-webhook-secret");
      if (sig !== deps.webhookSecret) {
        return c.json({ error: { code: "Unauthorized" } }, 401);
      }
    }
    await deps.cache.invalidateAll();
    return c.json({ ok: true });
  });

  return app;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
