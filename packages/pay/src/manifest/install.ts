// `pay install` — resolve every entry in a manifest into a fresh lockfile.

import type { Manifest, Lockfile, LockEntry } from "../types.ts";
import { resolveTool } from "./resolve.ts";

export interface InstallContext {
  fetchImpl?: typeof fetch;
}

export async function installManifest(
  manifest: Manifest,
  ctx: InstallContext = {},
): Promise<Lockfile> {
  const fetchedAt = new Date().toISOString();
  const resolved: Record<string, LockEntry> = {};
  for (const name of Object.keys(manifest.tools)) {
    const result = await resolveTool(name, {
      manifest,
      ...(ctx.fetchImpl !== undefined && { fetchImpl: ctx.fetchImpl }),
    });
    resolved[name] = {
      source: result.source,
      descriptor_id: result.descriptor_id,
      fetched_at: fetchedAt,
      descriptor: result.descriptor,
    };
  }
  return {
    pay_protocol: manifest.pay_protocol,
    lockfile_version: 1,
    resolved,
  };
}
