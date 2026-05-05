// Parse and validate tools.yml.

import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";
import type { Manifest, ManifestEntry } from "../types.ts";

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

export function parseManifest(yamlText: string): Manifest {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new ManifestParseError(`YAML parse error: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("manifest must be a YAML object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["pay_protocol"] !== "string") {
    throw new ManifestParseError("manifest missing required field `pay_protocol`");
  }
  if (
    typeof obj["tools"] !== "object" ||
    obj["tools"] === null ||
    Array.isArray(obj["tools"])
  ) {
    throw new ManifestParseError("manifest missing or invalid field `tools`");
  }
  const toolsRaw = obj["tools"] as Record<string, unknown>;
  const tools: Record<string, ManifestEntry> = {};
  for (const [name, entry] of Object.entries(toolsRaw)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new ManifestParseError(
        `tools.${name}: name must match [a-z0-9][a-z0-9._-]*`,
      );
    }
    if (typeof entry !== "object" || entry === null) {
      throw new ManifestParseError(`tools.${name} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const hasUrl = typeof e["url"] === "string";
    const hasPath = typeof e["path"] === "string";
    if (!hasUrl && !hasPath) {
      throw new ManifestParseError(`tools.${name}: must have either url or path`);
    }
    if (hasUrl && hasPath) {
      throw new ManifestParseError(`tools.${name}: cannot have both url and path`);
    }
    const integrity = e["integrity"];
    if (integrity !== undefined && typeof integrity !== "string") {
      throw new ManifestParseError(`tools.${name}.integrity must be a string`);
    }
    if (hasUrl) {
      tools[name] = {
        url: e["url"] as string,
        ...(integrity !== undefined && { integrity: integrity as string }),
      };
    } else {
      tools[name] = {
        path: e["path"] as string,
        ...(integrity !== undefined && { integrity: integrity as string }),
      };
    }
  }
  return {
    pay_protocol: obj["pay_protocol"] as string,
    tools,
  };
}

export function loadManifestFile(filePath: string): Manifest {
  if (!existsSync(filePath)) {
    throw new ManifestParseError(`manifest not found: ${filePath}`);
  }
  return parseManifest(readFileSync(filePath, "utf8"));
}
