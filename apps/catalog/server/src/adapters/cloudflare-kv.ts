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
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    });
  }

  async invalidate(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async invalidateAll(): Promise<void> {
    const list = await this.kv.list();
    await Promise.all(list.keys.map((k) => this.kv.delete(k.name)));
  }
}
