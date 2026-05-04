#!/usr/bin/env bun
// Stage 0 round-trip smoke:
// Fetch a descriptor from the live catalog, parse it as ToolDescriptor,
// re-canonicalize, hash, and verify the SHA matches what the catalog
// server stamped as the ETag. Validates the SPEC end-to-end:
//   - JCS canonicalization is deterministic
//   - sha256-base64url matches RFC encoding
//   - catalog server and client compute identical descriptor_ids
//   - TS types accept real catalog descriptors with no runtime error

import { descriptorId } from "../../src/descriptor-id.ts";
import type { ToolDescriptor } from "../../src/types.ts";

const CATALOG = "https://catalog.microchipgnu.workers.dev";
const TOOL_IDS = [
  "bazaar.api-exa-ai-search",
  "frames.test.post.api-echo",
  "frames.twitter.post.api-user-info",
  "mpp.agentmail.post.v0-inboxes",
];

let pass = 0;
let fail = 0;

for (const toolId of TOOL_IDS) {
  process.stdout.write(`${toolId.padEnd(40)} `);
  try {
    const res = await fetch(`${CATALOG}/tools/${toolId}`);
    if (!res.ok) {
      console.log(`✗ catalog ${res.status}`);
      fail++;
      continue;
    }
    const descriptor: ToolDescriptor = await res.json();
    // Prefer the X-Descriptor-Id header (always preserved); fall back to
    // the weak ETag without its W/" prefix and trailing quote.
    const serverId =
      res.headers.get("x-descriptor-id") ??
      (res.headers.get("etag") ?? "").replace(/^W\/"|"$/g, "");
    const localId = await descriptorId(descriptor);

    if (localId === serverId) {
      console.log(`✓ ${localId.slice(0, 28)}…`);
      pass++;
    } else {
      console.log(`✗ MISMATCH`);
      console.log(`    server: ${serverId}`);
      console.log(`    client: ${localId}`);
      fail++;
    }
  } catch (e) {
    console.log(`✗ ${(e as Error).message}`);
    fail++;
  }
}

console.log();
console.log(`${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
console.log("\n✓ Stage 0 contracts validated against live catalog");
