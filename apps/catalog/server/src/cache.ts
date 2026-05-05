export interface CachedEntry {
  etag: string;
  body: string;
  contentType: string;
}

export interface CatalogCache {
  get(key: string): Promise<CachedEntry | null>;
  set(key: string, value: CachedEntry, ttlSeconds?: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidateAll(): Promise<void>;
}
