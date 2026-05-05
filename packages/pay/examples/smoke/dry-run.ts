#!/usr/bin/env bun
// Smoke test, phase A: no wallet, no money.
// Picks 3 catalog tools (one Bazaar, one MPP, one Frames Registry),
// fetches the descriptor from catalog.frames.ag, hits the endpoint
// without payment, and reports what comes back.
//
// What we learn:
//   - Catalog returns valid descriptors with correct URLs
//   - Sellers actually exist and respond
//   - Sellers return 402 (not 401, 404, 500, etc.) for unauthenticated calls
//   - The 402 challenge body matches the protocol we expect

const CATALOG = "https://catalog.microchipgnu.workers.dev";

const TOOLS = [
  "bazaar.api-exa-ai-search",
  "mpp.anthropic.post.v1-models",
  "frames.twitter.post.api-user-info",
];

async function probe(toolId: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`tool: ${toolId}`);
  console.log("=".repeat(70));

  // Step 1: fetch descriptor from our catalog
  const descRes = await fetch(`${CATALOG}/tools/${toolId}`);
  if (!descRes.ok) {
    console.log(`  ❌ catalog returned ${descRes.status}`);
    return;
  }
  const descriptor = (await descRes.json()) as {
    id: string;
    invocation: { method: string; url: string };
    payment: { protocol: string; network?: string; price_hint?: string };
  };
  const etag = descRes.headers.get("etag");
  console.log(`  ✓ catalog returned descriptor`);
  console.log(`    invocation: ${descriptor.invocation.method} ${descriptor.invocation.url}`);
  console.log(`    payment:    ${descriptor.payment.protocol} on ${descriptor.payment.network ?? "?"}, hint $${descriptor.payment.price_hint ?? "?"}`);
  console.log(`    etag:       ${etag}`);

  // Step 2: hit the endpoint without payment, with a minimal sample body
  const sampleBody: Record<string, Record<string, unknown>> = {
    "bazaar.api-exa-ai-search": { query: "machine payment protocol", num_results: 1 },
    "mpp.anthropic.post.v1-models": {},
    "frames.twitter.post.api-user-info": { userName: "elonmusk" },
  };

  const body = sampleBody[toolId] ?? {};
  let res: Response;
  try {
    res = await fetch(descriptor.invocation.url, {
      method: descriptor.invocation.method,
      headers: { "Content-Type": "application/json" },
      body: descriptor.invocation.method === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.log(`  ❌ network error: ${(e as Error).message}`);
    return;
  }

  console.log(`  ${res.status === 402 ? "✓" : "?"} seller status: ${res.status} ${res.statusText}`);

  // Inspect challenge headers (x402v2 uses PAYMENT-REQUIRED, MPP uses WWW-Authenticate)
  const paymentRequired = res.headers.get("payment-required");
  const wwwAuth = res.headers.get("www-authenticate");
  if (paymentRequired) console.log(`    PAYMENT-REQUIRED: ${paymentRequired.slice(0, 100)}…`);
  if (wwwAuth) console.log(`    WWW-Authenticate: ${wwwAuth.slice(0, 100)}…`);

  // Body snapshot
  const text = await res.text();
  console.log(`    body (first 300 chars): ${text.slice(0, 300).replace(/\n/g, " ")}`);
}

async function main() {
  console.log(`Catalog: ${CATALOG}`);
  console.log(`Probing ${TOOLS.length} tools without paying...\n`);
  for (const t of TOOLS) {
    await probe(t);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
