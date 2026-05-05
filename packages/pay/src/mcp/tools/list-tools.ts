// list_tools — show every entry in tools.yml with its lock status.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../../config.ts";
import { loadManifestFile } from "../../manifest/load.ts";
import { loadLock } from "../../manifest/lock.ts";

export const listToolsSchema = {
  name: "list_tools",
  description:
    "List tools currently declared in tools.yml with their lock status (descriptor_id, fetched_at, source).",
  inputSchema: { type: "object", properties: {} },
};

export async function listToolsHandler(_args: unknown, config: RuntimeConfig) {
  const manifestPath = resolve(process.cwd(), config.manifestPath);
  const lockPath = resolve(process.cwd(), config.lockPath);

  if (!existsSync(manifestPath)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `no manifest at ${manifestPath} — use add_tool to start one`,
        },
      ],
    };
  }

  const manifest = loadManifestFile(manifestPath);
  const lock = existsSync(lockPath) ? loadLock(lockPath) : undefined;

  const lines: string[] = [`tools.yml (${Object.keys(manifest.tools).length} tools):`];
  for (const [name, entry] of Object.entries(manifest.tools)) {
    const locked = lock?.resolved[name];
    const src = "url" in entry ? entry.url : entry.path;
    lines.push(`  ${name}`);
    lines.push(`    source: ${src}`);
    if (locked) {
      lines.push(`    locked: ${locked.descriptor_id} (${locked.fetched_at})`);
      lines.push(
        `    pays:   ${locked.descriptor.payment.price_hint ?? "?"} ${locked.descriptor.payment.currency ?? ""} on ${locked.descriptor.payment.network ?? "?"} via ${locked.descriptor.payment.protocol}`,
      );
    } else {
      lines.push(`    locked: (not installed — call pay_tool or add_tool to resolve)`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
