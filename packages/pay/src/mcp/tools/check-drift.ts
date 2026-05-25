// check_descriptor_drift — compare each locked tool's descriptor against the
// live catalog. Surfaces sellers that changed their payment rail, price,
// invocation URL, or any other descriptor field since the lock was written.
//
// Programs should call this in preflight (free, no payment) before a discover
// or curate run. Verified 2026-05-25 against the layoffs-2026 case: spoofing
// the lockfile's payment.network to "solana-mainnet" still hit a seller
// demanding base/USDC, because the lock had diverged from what the seller
// actually advertises. This tool makes that divergence visible without paying.
//
// Out of scope for v0.0.1 of this tool: catching cases where the descriptor
// is in sync but the seller's live 402 challenge contradicts it (which is
// what truly happened above). That requires probing the seller's 402, which
// costs an HTTP round-trip and may be rate-limited. A follow-up.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../../config.ts";
import { canonicalize } from "../../canonical.ts";
import { descriptorId } from "../../descriptor-id.ts";
import { loadLock } from "../../manifest/lock.ts";
import type { LockEntry, ToolDescriptor } from "../../types.ts";

export const checkDescriptorDriftSchema = {
  name: "check_descriptor_drift",
  description:
    "Compare each locked tool's descriptor against the live catalog. " +
    "Returns a report of which tools are in sync, drifted, or unreachable, " +
    "with a per-field summary of what changed (focus on `payment.*`). " +
    "Free; makes one HTTP GET per locked tool to its source URL.",
  inputSchema: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        items: { type: "string" },
        description:
          "Local names to check. Omitted = check every tool in the lock. Empty array = same as omitted.",
      },
      include_fields: {
        type: "array",
        items: { type: "string" },
        description:
          "Dot-paths of descriptor fields to surface in the diff (default: " +
          'payment.network, payment.currency, payment.protocol, payment.price_hint, payment.accepts, ' +
          'invocation.url, invocation.method, capabilities). "*" reports every changed field.',
      },
    },
  },
};

interface DriftReport {
  checked: number;
  in_sync: number;
  drifted: number;
  unreachable: number;
  skipped: number;
  results: Array<DriftEntry>;
}

interface DriftEntry {
  local_name: string;
  status: "in_sync" | "drifted" | "unreachable" | "skipped";
  source_url?: string;
  lock_descriptor_id: string;
  live_descriptor_id?: string;
  changes?: Array<{ path: string; from: unknown; to: unknown }>;
  error?: string;
  skip_reason?: string;
}

const DEFAULT_FIELDS = [
  "payment.network",
  "payment.currency",
  "payment.protocol",
  "payment.price_hint",
  "payment.accepts",
  "invocation.url",
  "invocation.method",
  "capabilities",
];

export async function checkDescriptorDriftHandler(
  args: unknown,
  config: RuntimeConfig,
) {
  const argsObj = (args ?? {}) as { tools?: string[]; include_fields?: string[] };
  const filterTools = Array.isArray(argsObj.tools) && argsObj.tools.length > 0
    ? new Set(argsObj.tools)
    : null;
  const includeFields = Array.isArray(argsObj.include_fields) && argsObj.include_fields.length > 0
    ? argsObj.include_fields
    : DEFAULT_FIELDS;
  const reportAllFields = includeFields.includes("*");

  const lockPath = resolve(process.cwd(), config.lockPath);
  if (!existsSync(lockPath)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: { kind: "no_lock", message: `no lockfile at ${lockPath}` } },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  const lock = loadLock(lockPath);

  const entries = Object.entries(lock.resolved).filter(
    ([name]) => !filterTools || filterTools.has(name),
  );

  const report: DriftReport = {
    checked: entries.length,
    in_sync: 0,
    drifted: 0,
    unreachable: 0,
    skipped: 0,
    results: [],
  };

  for (const [localName, entry] of entries) {
    const result = await checkOne(localName, entry, includeFields, reportAllFields);
    report.results.push(result);
    report[result.status]++;
  }

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(report, null, 2) },
    ],
  };
}

async function checkOne(
  localName: string,
  entry: LockEntry,
  includeFields: string[],
  reportAllFields: boolean,
): Promise<DriftEntry> {
  const lockDescriptorId = entry.descriptor_id;
  const url = entry.source.url;
  const path = entry.source.path;

  if (!url && path) {
    // Local file — drift check is just "does the file still exist and parse
    // to the same descriptor_id?". Useful but limited; skip with a note.
    try {
      const text = readFileSync(resolve(process.cwd(), path), "utf-8");
      const live = JSON.parse(text) as ToolDescriptor;
      const liveId = await descriptorId(live);
      if (liveId === lockDescriptorId) {
        return {
          local_name: localName,
          status: "in_sync",
          lock_descriptor_id: lockDescriptorId,
          live_descriptor_id: liveId,
        };
      }
      return {
        local_name: localName,
        status: "drifted",
        lock_descriptor_id: lockDescriptorId,
        live_descriptor_id: liveId,
        changes: computeChanges(entry.descriptor, live, includeFields, reportAllFields),
      };
    } catch (e) {
      return {
        local_name: localName,
        status: "unreachable",
        lock_descriptor_id: lockDescriptorId,
        error: (e as Error).message,
      };
    }
  }

  if (!url) {
    return {
      local_name: localName,
      status: "skipped",
      lock_descriptor_id: lockDescriptorId,
      skip_reason: "no source.url or source.path on lock entry",
    };
  }

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return {
        local_name: localName,
        status: "unreachable",
        lock_descriptor_id: lockDescriptorId,
        source_url: url,
        error: `${res.status} ${res.statusText}`,
      };
    }
    const live = (await res.json()) as ToolDescriptor;
    // Recompute descriptor_id locally rather than trusting any header — this
    // is what the lock-verify path does too (see manifest/lock.ts:verifyLockEntry).
    const liveId = await descriptorId(live);
    if (liveId === lockDescriptorId) {
      return {
        local_name: localName,
        status: "in_sync",
        lock_descriptor_id: lockDescriptorId,
        live_descriptor_id: liveId,
        source_url: url,
      };
    }
    return {
      local_name: localName,
      status: "drifted",
      lock_descriptor_id: lockDescriptorId,
      live_descriptor_id: liveId,
      source_url: url,
      changes: computeChanges(entry.descriptor, live, includeFields, reportAllFields),
    };
  } catch (e) {
    return {
      local_name: localName,
      status: "unreachable",
      lock_descriptor_id: lockDescriptorId,
      source_url: url,
      error: (e as Error).message,
    };
  }
}

function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function computeChanges(
  lockDesc: ToolDescriptor,
  liveDesc: ToolDescriptor,
  includeFields: string[],
  reportAllFields: boolean,
): Array<{ path: string; from: unknown; to: unknown }> {
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];
  if (reportAllFields) {
    // Diff via canonical JSON — gives every changed top-level key.
    // (No deep recursion to keep output small; callers can pass explicit
    // dot-paths for finer grain.)
    for (const key of new Set([...Object.keys(lockDesc), ...Object.keys(liveDesc)])) {
      const from = (lockDesc as Record<string, unknown>)[key];
      const to = (liveDesc as Record<string, unknown>)[key];
      if (canonicalize(from) !== canonicalize(to)) {
        changes.push({ path: key, from, to });
      }
    }
    return changes;
  }
  for (const path of includeFields) {
    const from = getAtPath(lockDesc, path);
    const to = getAtPath(liveDesc, path);
    if (canonicalize(from) !== canonicalize(to)) {
      changes.push({ path, from, to });
    }
  }
  return changes;
}
