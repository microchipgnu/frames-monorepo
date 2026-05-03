import { Hono } from "hono";
import type { CatalogCache } from "./cache.js";
import type { ContentSource } from "./content.js";
import { fetchDescriptor, listDescriptorIds } from "./content.js";
import type { ListResponse } from "./types.js";

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
    const ids = await listDescriptorIds(deps.content);
    const tools = [] as ListResponse["tools"];
    for (const id of ids) {
      const f = await fetchDescriptor(deps.content, id);
      if (!f) continue;
      if (capability && !f.descriptor.capabilities.includes(capability)) continue;
      tools.push(f.descriptor);
    }
    const body: ListResponse = {
      pay_protocol: PAY_PROTOCOL,
      tools,
      cursor: null,
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
