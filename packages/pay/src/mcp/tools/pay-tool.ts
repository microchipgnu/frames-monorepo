// pay_tool — make a paid (or free) call by manifest local name, descriptor URL, or descriptor_id.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../../config.ts";
import { classifyPayError } from "../../errors.ts";
import { loadManifestFile } from "../../manifest/load.ts";
import { loadLock, saveLock, setLockEntry } from "../../manifest/lock.ts";
import { resolveTool } from "../../manifest/resolve.ts";
import { payForTool } from "../../wallet/dispatch.ts";

export const payToolSchema = {
  name: "pay_tool",
  description:
    "Resolve a tool, pay if needed, call the seller, return body + signed receipt. " +
    "name is a manifest local name (preferred), descriptor URL, or descriptor_id. " +
    "params is a JSON object matching the tool's params_schema. " +
    "On failure returns isError=true with a typed error: " +
    "{ kind: insufficient_funds | network_unconfigured | agentwallet_unreachable | seller_rejected | balance_check_failed | wallet_signing_error | descriptor_mismatch | unknown, message, retryable, details? }.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Local name from tools.yml, descriptor URL, or descriptor_id" },
      params: { type: "object", description: "Arguments for the tool" },
    },
    required: ["name", "params"],
  },
};

export async function payToolHandler(args: unknown, config: RuntimeConfig) {
  const { name, params } = args as { name: string; params: unknown };

  const manifestPath = resolve(process.cwd(), config.manifestPath);
  const lockPath = resolve(process.cwd(), config.lockPath);

  const manifest = existsSync(manifestPath)
    ? loadManifestFile(manifestPath)
    : undefined;
  const lock = existsSync(lockPath) ? loadLock(lockPath) : undefined;

  // If the name resolves via manifest URL but isn't yet in the lock, write the
  // freshly-resolved entry so subsequent calls hit the cache.
  if (manifest?.tools[name] && !lock?.resolved[name]) {
    try {
      const resolved = await resolveTool(name, {
        manifest,
        ...(lock !== undefined && { lock }),
        catalog: config.defaultCatalog,
      });
      const newLock = setLockEntry(lock ?? { pay_protocol: "0.0.1", lockfile_version: 1, resolved: {} }, name, {
        source: resolved.source,
        descriptor_id: resolved.descriptor_id,
        fetched_at: new Date().toISOString(),
        descriptor: resolved.descriptor,
      });
      saveLock(lockPath, newLock);
    } catch (e) {
      return errorResponse(e);
    }
  }

  const lockAfter = existsSync(lockPath) ? loadLock(lockPath) : undefined;

  let result;
  try {
    result = await payForTool(
      {
        name,
        params,
        ...(manifest !== undefined && { manifest }),
        ...(lockAfter !== undefined && { lock: lockAfter }),
        catalog: config.defaultCatalog,
      },
      { registry: config.registry, auditKey: config.auditKey },
    );
  } catch (e) {
    return errorResponse(e);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            body: result.body,
            receipt: {
              id: result.receipt.id,
              tool_id: result.receipt.tool_id,
              tool_local_name: result.receipt.tool_local_name,
              descriptor_id: result.receipt.descriptor_id,
              amount: result.receipt.amount,
              currency: result.receipt.currency,
              network: result.receipt.network,
              tx_hash: result.receipt.tx_hash,
              wallet_address: result.receipt.wallet_address,
              ts: result.receipt.ts,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function errorResponse(err: unknown) {
  const classified = classifyPayError(err);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: classified }, null, 2),
      },
    ],
    isError: true,
  };
}
