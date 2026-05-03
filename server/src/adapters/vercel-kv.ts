import { kv } from "@vercel/kv";
import type { CachedEntry, CatalogCache } from "../cache.js";

export class VercelKvCache implements CatalogCache {
  async get(key: string): Promise<CachedEntry | null> {
    return (await kv.get(key)) as CachedEntry | null;
  }

  async set(
    key: string,
    value: CachedEntry,
    ttlSeconds = 60,
  ): Promise<void> {
    await kv.set(key, value, { ex: ttlSeconds });
  }

  async invalidate(key: string): Promise<void> {
    await kv.del(key);
  }

  async invalidateAll(): Promise<void> {
    const keys = await kv.keys("*");
    if (keys.length) await kv.del(...keys);
  }
}
