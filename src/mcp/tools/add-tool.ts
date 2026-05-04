// add_tool — append a new tool to tools.yml + tools.lock from a descriptor URL.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../../config.ts";
import { resolveTool } from "../../manifest/resolve.ts";
import { loadLock, saveLock, setLockEntry } from "../../manifest/lock.ts";

export const addToolSchema = {
  name: "add_tool",
  description:
    "Add a tool to tools.yml + tools.lock by descriptor URL. " +
    "If `as` is omitted, derives a local name from the descriptor's id.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Descriptor URL" },
      as: { type: "string", description: "Local name (optional)" },
    },
    required: ["url"],
  },
};

export async function addToolHandler(args: unknown, config: RuntimeConfig) {
  const { url, as } = args as { url: string; as?: string };

  const resolved = await resolveTool(url, { catalog: config.defaultCatalog });
  const localName = as ?? deriveLocalName(resolved.descriptor.id);

  const manifestPath = resolve(process.cwd(), config.manifestPath);
  const lockPath = resolve(process.cwd(), config.lockPath);

  // Append to tools.yml (text-edit, not YAML re-emit, to preserve user formatting)
  appendToManifestYaml(manifestPath, localName, url);

  // Update tools.lock
  const lock = existsSync(lockPath)
    ? loadLock(lockPath)
    : { pay_protocol: "0.0.1" as const, lockfile_version: 1 as const, resolved: {} };
  const newLock = setLockEntry(lock, localName, {
    source: { url },
    descriptor_id: resolved.descriptor_id,
    fetched_at: new Date().toISOString(),
    descriptor: resolved.descriptor,
  });
  saveLock(lockPath, newLock);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `added "${localName}" → ${resolved.descriptor.id}\n` +
          `  descriptor_id: ${resolved.descriptor_id}\n` +
          `  protocol: ${resolved.descriptor.payment.protocol}\n` +
          `  network: ${resolved.descriptor.payment.network ?? "(none)"}\n` +
          `  price hint: ${resolved.descriptor.payment.price_hint ?? "(none)"} ${
            resolved.descriptor.payment.currency ?? ""
          }`,
      },
    ],
  };
}

function deriveLocalName(descriptorId: string): string {
  // bazaar.api-exa-ai-search → search; mpp.anthropic.post.v1-messages → messages
  // Heuristic: take the last dot-segment, strip protocol/method prefixes.
  const last = descriptorId.split(".").pop() ?? descriptorId;
  return last.replace(/^(post|get|put|delete|api)-/, "");
}

function appendToManifestYaml(
  manifestPath: string,
  name: string,
  url: string,
): void {
  let text: string;
  if (existsSync(manifestPath)) {
    text = readFileSync(manifestPath, "utf8");
    if (!text.includes("tools:")) {
      text = text.trimEnd() + "\ntools:\n";
    }
    text = text.trimEnd() + `\n  ${name}:\n    url: ${url}\n`;
  } else {
    text = `pay_protocol: 0.0.1\ntools:\n  ${name}:\n    url: ${url}\n`;
  }
  writeFileSync(manifestPath, text);
}
