// Read, write, and integrity-check tools.lock.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Lockfile, LockEntry } from "../types.ts";
import { descriptorId } from "../descriptor-id.ts";

export class LockfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileError";
  }
}

const PAY_PROTOCOL = "0.0.1";
const LOCKFILE_VERSION = 1;

export function emptyLock(): Lockfile {
  return {
    pay_protocol: PAY_PROTOCOL,
    lockfile_version: LOCKFILE_VERSION,
    resolved: {},
  };
}

export function loadLock(filePath: string): Lockfile {
  if (!existsSync(filePath)) return emptyLock();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new LockfileError(`JSON parse error: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LockfileError("lockfile must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj["lockfile_version"] !== LOCKFILE_VERSION) {
    throw new LockfileError(
      `unsupported lockfile_version: ${obj["lockfile_version"]} (expected ${LOCKFILE_VERSION})`,
    );
  }
  if (
    typeof obj["resolved"] !== "object" ||
    obj["resolved"] === null ||
    Array.isArray(obj["resolved"])
  ) {
    throw new LockfileError("lockfile.resolved must be an object");
  }
  return obj as unknown as Lockfile;
}

export function saveLock(filePath: string, lock: Lockfile): void {
  writeFileSync(filePath, JSON.stringify(lock, null, 2) + "\n");
}

/**
 * Verify a lock entry's inlined descriptor still hashes to its descriptor_id.
 * Throws on mismatch — means the lock was tampered with or corrupted.
 */
export async function verifyLockEntry(entry: LockEntry): Promise<void> {
  const computed = await descriptorId(entry.descriptor);
  if (computed !== entry.descriptor_id) {
    throw new LockfileError(
      `Lock entry SHA mismatch: expected ${entry.descriptor_id}, computed ${computed}`,
    );
  }
}

export function setLockEntry(
  lock: Lockfile,
  name: string,
  entry: LockEntry,
): Lockfile {
  return {
    ...lock,
    resolved: { ...lock.resolved, [name]: entry },
  };
}

export function removeLockEntry(lock: Lockfile, name: string): Lockfile {
  const { [name]: _, ...rest } = lock.resolved;
  return { ...lock, resolved: rest };
}
