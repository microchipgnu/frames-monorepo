import type { CachedEntry, CatalogCache } from "../cache.js";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export class CloudflareKvCache implements CatalogCache {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<CachedEntry | null> {
    const raw = await this.kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedEntry;
  }

  async set(
    key: string,
    value: CachedEntry,
    ttlSeconds = 60,
  ): Promise<void> {
    const serialized = JSON.stringify(value);
    // CF KV has a 25 MB per-value limit + a 60 s minimum TTL. If the entry
    // is too big or the call rejects for any reason, swallow it — the
    // route still completes via the upstream content fetch, just uncached.
    // (The 47k-descriptor index is ~56 MB serialized — too large for KV.
    // List handlers should swap to a slim projection or in-isolate cache
    // before this becomes a latency problem.)
    if (serialized.length > 24 * 1024 * 1024) return;
    try {
      await this.kv.put(key, serialized, {
        expirationTtl: Math.max(ttlSeconds, 60),
      });
    } catch (e) {
      // Don't propagate — cache failures should never 500 the request.
      console.warn(`KV put failed for ${key}:`, e);
    }
  }

  async invalidate(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async invalidateAll(): Promise<void> {
    const list = await this.kv.list();
    await Promise.all(list.keys.map((k) => this.kv.delete(k.name)));
  }
}
