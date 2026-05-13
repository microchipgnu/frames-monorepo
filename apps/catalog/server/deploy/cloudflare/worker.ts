import { createHandler } from "../../src/handler.js";
import { CloudflareKvCache } from "../../src/adapters/cloudflare-kv.js";
import { defaultContent } from "../../src/content.js";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export interface Env {
  CATALOG_KV: KVNamespace;
  WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  // Override the content base URL. Production: leave unset (defaults to
  // raw.githubusercontent.com/main/apps/catalog/content). Dev: point to a
  // local static file server (`http://localhost:4000`).
  CATALOG_CONTENT_BASE?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const handler = createHandler({
      cache: new CloudflareKvCache(env.CATALOG_KV),
      content: {
        baseUrl: env.CATALOG_CONTENT_BASE ?? defaultContent.baseUrl,
        ...(env.GITHUB_TOKEN ? { githubToken: env.GITHUB_TOKEN } : {}),
      },
      webhookSecret: env.WEBHOOK_SECRET,
    });
    return handler.fetch(req);
  },
};
