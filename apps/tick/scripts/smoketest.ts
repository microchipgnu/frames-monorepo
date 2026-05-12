// Smoke test for the local tick dev server.
//
// Boots the Hono app in-process (no Cloudflare runtime needed) and hits:
//   1. GET /              — basic liveness
//   2. POST /run {op:"verify", frame: a real public frame} — full read+refetch flow
//
// Expects no creds, no x402, no D1. Just verifies the scaffold pipeline:
//   FrameClient → frames-cloud.workers.dev → projection → verify op → drift report
//
// Run:  bun run smoke
//
// On a healthy install you should see something like:
//   ✓ GET /             ok
//   ✓ POST /run verify  scanned 13 entities, 47 fields checked, 0 drifts

import app from "../src/app";

const FRAME = process.env.SMOKE_FRAME ?? "https://github.com/microchipgnu/ai-agent-wallets-eu";

// Smoke test opens the agent gate (`TICK_ALLOWED_AGENTS=*`). Production
// deploys keep this closed by default — this is dev-only.
const SMOKE_ENV = {
  TICK_ALLOWED_AGENTS: "*",
  FRAMES_CLOUD_BASE: process.env.FRAMES_CLOUD_BASE,
};

async function main() {
  let failures = 0;

  // 1. liveness
  {
    const res = await app.request("/");
    const ok = res.status === 200;
    console.log(`${ok ? "✓" : "✗"} GET /             ${ok ? "ok" : `failed (${res.status})`}`);
    if (!ok) failures++;
  }

  // 2. health
  {
    const res = await app.request("/health");
    const ok = res.status === 200;
    console.log(`${ok ? "✓" : "✗"} GET /health       ${ok ? "ok" : `failed (${res.status})`}`);
    if (!ok) failures++;
  }

  // 3. POST /run verify — exercises the full read+refetch flow against frames-cloud.
  //    Skips gracefully when frames-cloud isn't reachable (e.g. before Tier 1
  //    deploy). Set FRAMES_CLOUD_BASE=http://localhost:8787 to test against a
  //    local `bun --hot src/index.ts` in apps/frames-cloud.
  {
    const body = JSON.stringify({ op: "verify", frame: FRAME, budget: "0.15" });
    const res = await app.request("/run", { method: "POST", headers: { "content-type": "application/json" }, body }, SMOKE_ENV);
    const json = (await res.json()) as Record<string, unknown>;
    const ok = res.status === 200 && !json.error;
    if (ok) {
      const summary = json.summary ?? "(no summary)";
      console.log(`✓ POST /run verify  ${summary}`);
    } else {
      const err = String(json.error ?? "");
      const offline = err.includes("Unable to connect") || err.includes("ENOTFOUND") || err.includes("ECONNREFUSED");
      if (offline) {
        console.log(`⚠ POST /run verify  frames-cloud unreachable at ${SMOKE_ENV.FRAMES_CLOUD_BASE ?? "https://frames-cloud.workers.dev"}`);
        console.log(`   (run \`bun --hot src/index.ts\` in apps/frames-cloud and re-run with FRAMES_CLOUD_BASE=http://localhost:8787)`);
      } else {
        console.log(`✗ POST /run verify  failed (${res.status})`);
        console.log(`    ${JSON.stringify(json).slice(0, 300)}`);
        failures++;
      }
    }
  }

  // 4. validation: bad op (allowlist is still in front; need SMOKE_ENV)
  {
    const res = await app.request(
      "/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "nonsense", frame: FRAME, budget: "0.1" }),
      },
      SMOKE_ENV,
    );
    const ok = res.status === 400;
    console.log(`${ok ? "✓" : "✗"} POST /run bad-op  ${ok ? "rejects with 400" : `unexpected ${res.status}`}`);
    if (!ok) failures++;
  }

  // 4b. /run is closed by default — no SMOKE_ENV → 403
  {
    const res = await app.request("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "verify", frame: FRAME, budget: "0.15" }),
    });
    const json = (await res.json()) as { code?: string };
    const ok = res.status === 403 && json.code === "agent_not_allowlisted";
    console.log(`${ok ? "✓" : "✗"} POST /run closed  ${ok ? "403 agent_not_allowlisted" : `unexpected ${res.status} ${json.code}`}`);
    if (!ok) failures++;
  }

  // 5. /history rejects unauthenticated requests. Accepts 401 (no address)
  //    when a D1 binding is present, or 503 (no D1 binding) in bun-mode dev
  //    without Miniflare. Both confirm the endpoint is wired and gated.
  {
    const res = await app.request("/history");
    const ok = res.status === 401 || res.status === 503;
    console.log(`${ok ? "✓" : "✗"} GET /history      ${ok ? `rejects with ${res.status}` : `unexpected ${res.status}`}`);
    if (!ok) failures++;
  }

  // 6. DELETE /history same: 401 with DB, 503 without. Either is correct.
  {
    const res = await app.request("/history", { method: "DELETE" });
    const ok = res.status === 401 || res.status === 503;
    console.log(`${ok ? "✓" : "✗"} DELETE /history   ${ok ? `rejects with ${res.status}` : `unexpected ${res.status}`}`);
    if (!ok) failures++;
  }

  // 7. SSE response — Accept: text/event-stream switches to streaming. Read
  //    the first chunk and confirm it contains the `started` event frame.
  //    Skips gracefully when frames-cloud is unreachable (same as case 3).
  {
    const body = JSON.stringify({ op: "verify", frame: FRAME, budget: "0.15" });
    const res = await app.request(
      "/run",
      { method: "POST", headers: { "content-type": "application/json", "accept": "text/event-stream" }, body },
      SMOKE_ENV,
    );
    const ct = res.headers.get("content-type") ?? "";
    const isSse = ct.includes("text/event-stream");
    if (!isSse) {
      console.log(`✗ POST /run sse     content-type was ${ct}, expected text/event-stream`);
      failures++;
    } else {
      // Read the first 256 bytes; the `started` frame should be in there.
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const head = new TextDecoder().decode(value ?? new Uint8Array());
      await reader.cancel();
      const hasStarted = head.includes("event: started");
      console.log(`${hasStarted ? "✓" : "✗"} POST /run sse     ${hasStarted ? "started frame emitted" : "no started frame in first chunk"}`);
      if (!hasStarted) failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll smoke tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
