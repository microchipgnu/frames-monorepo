// SPEC resolution algorithm:
//   1. lock entry → use inlined descriptor (verify SHA)
//   2. manifest entry → fetch URL/path, compute SHA, return (caller decides
//      whether to write to lock — install does, run doesn't)
//   3. URL → fetch directly, no lock write
//   4. catalog → look up by id, no lock write
//   5. fail.

import { readFileSync } from "node:fs";
import type {
  Manifest,
  Lockfile,
  ToolDescriptor,
  CatalogSource,
} from "../types.ts";
import { descriptorId } from "../descriptor-id.ts";
import { verifyLockEntry, LockfileError } from "./lock.ts";

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface ResolveContext {
  manifest?: Manifest;
  lock?: Lockfile;
  catalog?: CatalogSource;
  fetchImpl?: typeof fetch;
}

export interface ResolvedToolEntry {
  descriptor: ToolDescriptor;
  descriptor_id: string;
  source: { url?: string; path?: string };
  /** Where this resolution came from. */
  via: "lock" | "manifest-url" | "manifest-path" | "url" | "catalog";
}

export async function resolveTool(
  name: string,
  ctx: ResolveContext,
): Promise<ResolvedToolEntry> {
  // 1. lock
  if (ctx.lock?.resolved[name]) {
    const entry = ctx.lock.resolved[name];
    await verifyLockEntry(entry);
    return {
      descriptor: entry.descriptor,
      descriptor_id: entry.descriptor_id,
      source: entry.source,
      via: "lock",
    };
  }

  // 2. manifest
  if (ctx.manifest?.tools[name]) {
    const me = ctx.manifest.tools[name];
    if (me.url) {
      const descriptor = await fetchAndValidate(
        me.url,
        me.integrity,
        ctx.fetchImpl,
      );
      const id = await descriptorId(descriptor);
      return {
        descriptor,
        descriptor_id: id,
        source: { url: me.url },
        via: "manifest-url",
      };
    }
    if (me.path) {
      let text: string;
      try {
        text = readFileSync(me.path, "utf8");
      } catch (e) {
        throw new ResolveError(
          `failed to read ${me.path}: ${(e as Error).message}`,
        );
      }
      let descriptor: ToolDescriptor;
      try {
        descriptor = JSON.parse(text) as ToolDescriptor;
      } catch (e) {
        throw new ResolveError(
          `${me.path} is not valid JSON: ${(e as Error).message}`,
        );
      }
      const id = await descriptorId(descriptor);
      if (me.integrity && me.integrity !== id) {
        throw new ResolveError(
          `integrity mismatch at ${me.path}: expected ${me.integrity}, computed ${id}`,
        );
      }
      return {
        descriptor,
        descriptor_id: id,
        source: { path: me.path },
        via: "manifest-path",
      };
    }
  }

  // 3. URL
  if (name.startsWith("http://") || name.startsWith("https://")) {
    const descriptor = await fetchAndValidate(name, undefined, ctx.fetchImpl);
    const id = await descriptorId(descriptor);
    return {
      descriptor,
      descriptor_id: id,
      source: { url: name },
      via: "url",
    };
  }

  // 4. catalog (look up by id)
  if (ctx.catalog) {
    const descriptor = await ctx.catalog.get(name);
    if (descriptor) {
      const id = await descriptorId(descriptor);
      return {
        descriptor,
        descriptor_id: id,
        source: { url: `${ctx.catalog.id}/tools/${name}` },
        via: "catalog",
      };
    }
  }

  throw new ResolveError(
    `cannot resolve "${name}": not in lock, not in manifest, not a URL, not in catalog`,
  );
}

async function fetchAndValidate(
  url: string,
  expected: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<ToolDescriptor> {
  const f = fetchImpl ?? fetch;
  const res = await f(url);
  if (!res.ok) {
    throw new ResolveError(`fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const descriptor = (await res.json()) as ToolDescriptor;
  if (expected) {
    const computed = await descriptorId(descriptor);
    if (computed !== expected) {
      throw new LockfileError(
        `integrity mismatch at ${url}: expected ${expected}, computed ${computed}`,
      );
    }
  }
  return descriptor;
}
