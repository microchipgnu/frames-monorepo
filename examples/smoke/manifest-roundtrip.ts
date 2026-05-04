#!/usr/bin/env bun
// Stage 1a end-to-end:
//   1. Build a tools.yml referencing 3 catalog URLs
//   2. parseManifest → installManifest → saveLock
//   3. loadLock → resolveTool(name, { lock }) → verify SHA round-trips
//   4. Re-install and assert lock is reproducible (deterministic SHAs)

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseManifest } from "../../src/manifest/load.ts";
import { installManifest } from "../../src/manifest/install.ts";
import { loadLock, saveLock } from "../../src/manifest/lock.ts";
import { resolveTool } from "../../src/manifest/resolve.ts";

const CATALOG = "https://catalog.microchipgnu.workers.dev";
const dir = mkdtempSync(join(tmpdir(), "pay-smoke-"));

let exitCode = 0;
try {
  const yamlText = `pay_protocol: 0.0.1
tools:
  search:
    url: ${CATALOG}/tools/bazaar.api-exa-ai-search
  test:
    url: ${CATALOG}/tools/frames.test.post.api-echo
  twitter:
    url: ${CATALOG}/tools/frames.twitter.post.api-user-info
`;
  const manifestPath = join(dir, "tools.yml");
  const lockPath = join(dir, "tools.lock");
  writeFileSync(manifestPath, yamlText);
  console.log(`Workspace: ${dir}`);

  // 1. parse
  const manifest = parseManifest(yamlText);
  const toolNames = Object.keys(manifest.tools);
  console.log(`Parsed manifest with ${toolNames.length} tools`);

  // 2. install
  console.log("\nInstalling…");
  const lock = await installManifest(manifest);
  saveLock(lockPath, lock);
  console.log(`  wrote tools.lock (${Object.keys(lock.resolved).length} entries)`);

  // 3. load + resolve from lock
  const reloaded = loadLock(lockPath);
  console.log("\nResolving from lock:");
  let pass = 0;
  for (const name of toolNames) {
    process.stdout.write(`  ${name.padEnd(10)} `);
    try {
      const r = await resolveTool(name, { lock: reloaded });
      console.log(`✓ via=${r.via}, ${r.descriptor_id.slice(0, 28)}…`);
      pass++;
    } catch (e) {
      console.log(`✗ ${(e as Error).message}`);
    }
  }
  if (pass !== toolNames.length) exitCode = 1;

  // 4. reproducibility
  console.log("\nReproducibility (re-install, compare SHAs):");
  const lock2 = await installManifest(manifest);
  let same = 0;
  for (const name of toolNames) {
    const a = lock.resolved[name]?.descriptor_id;
    const b = lock2.resolved[name]?.descriptor_id;
    if (a && a === b) {
      same++;
    } else {
      console.log(`  ${name}: DIFFERS  ${a} vs ${b}`);
    }
  }
  console.log(`  ${same}/${toolNames.length} entries match across runs`);
  if (same !== toolNames.length) exitCode = 1;

  // 5. integrity check — try resolving with a wrong integrity
  console.log("\nIntegrity check (deliberate SHA mismatch):");
  const badYaml = `pay_protocol: 0.0.1
tools:
  search:
    url: ${CATALOG}/tools/bazaar.api-exa-ai-search
    integrity: sha256-WRONGwrongWRONGwrongWRONGwrongWRONGwrongWRO
`;
  try {
    await installManifest(parseManifest(badYaml));
    console.log("  ✗ should have thrown");
    exitCode = 1;
  } catch (e) {
    console.log(`  ✓ rejected: ${(e as Error).message.slice(0, 80)}`);
  }

  console.log();
  if (exitCode === 0) {
    console.log("✓ Stage 1a manifest+lock+resolve roundtrip works");
  } else {
    console.log("✗ Stage 1a smoke had failures");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exitCode);
