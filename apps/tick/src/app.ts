// Hono app for tick. Same module loaded by Bun (src/index.ts) and Cloudflare
// Workers (when wrangler deploys). All real logic lives downstream of POST /run.
//
// Week 1 scaffold: only the stub /run handler exists. Week 2 wires:
//   - x402 verify+settle via the Faremeter facilitator
//   - RunSession DO dispatch
//   - frame MCP client + catalog tools
//   - the four ops (curate/refresh/verify/discover)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { DEFAULT_BUDGETS, type Op, type RunInput, type RunResult } from "@frames-ag/tick-types";
import {
  finalizeRun,
  findRunByIdempotencyKey,
  getRun,
  getRunEvents,
  getRunToolCalls,
  insertEvent,
  insertRun,
  insertToolCall,
  listRunsByAgent,
  purgeRunsByAgent,
} from "./db";
import type { Bindings } from "./env";
import { CatalogClient } from "./catalog/client";
import { FrameClient, FrameClientError } from "./frame-client";
import { LlmClient } from "./llm/client";
import { curate as curateOp } from "./ops/curate";
import { discover as discoverOp } from "./ops/discover";
import { refresh as refreshOp } from "./ops/refresh";
import { verify as verifyOp } from "./ops/verify";
import { createHttpRefetcher } from "./ops/refetcher";
import { createPaidRefetcher } from "./ops/paid-refetcher";
import type { OpOutcome, Refetcher } from "./ops/types";
import { checkAllowlist, parseAllowlist } from "./allowlist";
import { lookupApiKey, parseApiKeys } from "./api-key";
import { buildPaymentRequirements } from "./payment/payment-requirements";
import type { PaymentPayload, PaymentRequirements } from "./payment/types";
import { settleX402, verifyInboundX402 } from "./payment/x402";
import { checkRateLimit, identityKeyForRequest } from "./rate-limit";
import { errorResponse } from "./util/errors";
import { log } from "./util/log";
import { bootWallets, type BootedWallets } from "./wallet";

const VALID_OPS: ReadonlySet<Op> = new Set(["curate", "refresh", "verify", "discover"]);

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", cors());

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "tick",
    description: "Hosted runtime for frame datasets",
    ops: Array.from(VALID_OPS),
    docs: "https://tick.frames.ag",
  }),
);

app.get("/health", (c) => {
  const allowlistEntries = parseAllowlist(c.env?.TICK_ALLOWED_AGENTS);
  const allowlistOpen = allowlistEntries.includes("*");
  const apiKeyEntries = parseApiKeys(c.env?.TICK_API_KEYS);
  return c.json({
    ok: true,
    ts: new Date().toISOString(),
    db: !!c.env?.DB,
    wallets: {
      solana_configured: !!(c.env?.SOLANA_OUTBOUND_KEYPAIR_JSON && c.env?.SOLANA_RPC_URL),
      evm_configured: !!c.env?.EVM_OUTBOUND_PRIVATE_KEY,
    },
    payments: {
      facilitator_configured: !!c.env?.FACILITATOR_URL,
      audit_key_configured: !!c.env?.AUDIT_PRIVATE_KEY,
      pay_to_configured: !!c.env?.TICK_PAY_TO_ADDRESS,
    },
    llm: {
      ai_gateway_configured: !!(c.env?.AI_GATEWAY_URL && c.env?.AI_GATEWAY_BYOK_ALIAS),
      anthropic_passthrough_configured: !!c.env?.ANTHROPIC_API_KEY,
    },
    hosted: {
      allowlist_entries: allowlistEntries.length,
      allowlist_open: allowlistOpen,
      // True iff the operator hasn't configured the allowlist yet — useful
      // smoke-check: a freshly-deployed Worker is closed by default.
      closed_by_default: allowlistEntries.length === 0,
      api_key_count: apiKeyEntries.length,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /run — main op runner
//
// Week 1: stub. Validates the request, echoes it back. No x402, no agent loop.
// Week 2: real x402 verify → RunSession DO → op loop → settle.
// ---------------------------------------------------------------------------

app.post("/run", async (c) => {
  let body: RunInput;
  try {
    body = (await c.req.json()) as RunInput;
  } catch {
    return errorResponse(c, 400, "invalid_json", "Request body is not valid JSON");
  }

  if (!body || typeof body !== "object") {
    return errorResponse(c, 400, "invalid_body", "Request body must be an object");
  }
  if (!body.op || !VALID_OPS.has(body.op)) {
    return errorResponse(c, 400, "invalid_op", `op must be one of: ${Array.from(VALID_OPS).join(", ")}`, {
      got: body.op,
      expected: Array.from(VALID_OPS),
    });
  }
  if (!body.frame || typeof body.frame !== "string" || !body.frame.startsWith("https://github.com/")) {
    return errorResponse(c, 400, "invalid_frame", "frame must be a https://github.com/... URL", {
      expected: "https://github.com/<user>/<repo>[/<path>]",
    });
  }

  const budget = body.budget ?? DEFAULT_BUDGETS[body.op];
  const run_id = `run_${crypto.randomUUID()}`;

  // Identity resolution, priority order:
  //   1. Bearer token mapped via TICK_API_KEYS → stable agent identifier
  //   2. (Later) x402-verified payer → frames-runtime:<wallet>
  //   3. IP-hashed fallback → frames-runtime:ip:<sha1prefix>
  //
  // Bearer token is checked first so closed-alpha customers get stable
  // identity even when they hit us from rotating CI runner IPs. A bearer
  // header that doesn't match a configured key returns 401 immediately
  // (does NOT fall through) — prevents junk-key→IP-hash silent downgrade.
  const apiKeyLookup = lookupApiKey(c.req.raw, c.env?.TICK_API_KEYS);
  if (apiKeyLookup.unauthorized) {
    log.warn("api_key_unauthorized", { reason: apiKeyLookup.reason });
    return errorResponse(c, 401, "invalid_api_key", apiKeyLookup.reason ?? "invalid Bearer token");
  }
  const agent = apiKeyLookup.matched && apiKeyLookup.agent
    ? apiKeyLookup.agent
    : `frames-runtime:${await identityKeyForRequest(c.req.raw)}`;
  const started_at = new Date().toISOString();

  // Idempotency-Key: if present and we've seen it before, replay the original
  // result instead of running again. Standard pattern for at-least-once retries.
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey && c.env?.DB) {
    const existing = await findRunByIdempotencyKey(c.env.DB, idempotencyKey);
    if (existing) {
      if (existing.status === "running" || existing.status === "pending") {
        return errorResponse(c, 409, "idempotency_conflict", "Run with this Idempotency-Key is still in progress", {
          run_id: existing.run_id,
          status: existing.status,
        });
      }
      // Terminal: return the existing receipt by redirect → /runs/:id semantics inline
      log.info("idempotency_replay", { idempotency_key: idempotencyKey, run_id: existing.run_id, status: existing.status });
      return c.json({
        run_id: existing.run_id,
        op: existing.op,
        frame: existing.frame,
        settled: existing.settled,
        status: existing.status,
        replayed: true,
        note: `Replayed result for Idempotency-Key=${idempotencyKey}. Fetch /runs/${existing.run_id} for full receipt.`,
      });
    }
  }

  log.info("run_started", { run_id, op: body.op, frame: body.frame, agent, budget, idempotency_key: idempotencyKey ?? null });

  // Rate limit BEFORE we do any expensive work. Skip when no DB binding
  // (bun --hot dev). Fail-open on DB errors (see rate-limit.ts).
  if (c.env?.DB) {
    const rateKey = agent;
    const check = await checkRateLimit(c.env.DB, rateKey);
    if (!check.allowed) {
      return errorResponse(
        c,
        429,
        "rate_limited",
        `Rate limit exceeded — retry after ${check.retry_after_seconds}s`,
        {
          op: body.op,
          retry_after_seconds: check.retry_after_seconds,
          remaining_per_minute: check.remaining_per_minute,
          remaining_per_hour: check.remaining_per_hour,
          checked_at: check.checked_at,
        },
        {
          "Retry-After": String(check.retry_after_seconds ?? 60),
          "X-RateLimit-Remaining-Minute": String(check.remaining_per_minute),
          "X-RateLimit-Remaining-Hour": String(check.remaining_per_hour),
        },
      );
    }
  }

  // ---------------------------------------------------------------------
  // Inbound x402 verify (optional in dev).
  //
  // If the client sent a PAYMENT-SIGNATURE / Payment header AND the worker
  // has FACILITATOR_URL set, we call /verify upfront. On failure we return
  // 401 — the customer paid for nothing and we don't dispatch the op.
  //
  // When no header is present we proceed unauthenticated and log a warning.
  // This is "optional" mode; production deployments set the facilitator URL
  // AND require callers to send the payment header. Settlement happens after
  // op completion in week-2 wiring (not in this stub path).
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // x402 v2 inbound: build PaymentRequirements from env + op + budget, then:
  //   - Strict mode (FACILITATOR_URL set AND TICK_PAY_TO_ADDRESS set):
  //     no header → 402 challenge with the PaymentRequirements
  //     bad header → 401
  //     good header → continue with verified payer identity
  //   - Optional mode (dev / smoketest): missing header is fine, log a warning.
  // ---------------------------------------------------------------------
  const paymentRequirements = buildPaymentRequirements(c.env, body.op, body.budget);
  const x402Strict = !!c.env?.FACILITATOR_URL && !!paymentRequirements;
  const x402 = await verifyInboundX402(c.req.raw, c.env?.FACILITATOR_URL, paymentRequirements, {
    optional: !x402Strict,
  });

  if (!x402.ok) {
    // Missing-header in strict mode → 402 challenge with the PaymentRequirements
    // the client should sign and retry with.
    const noHeader = c.req.header("payment-signature") === undefined;
    if (x402Strict && noHeader && paymentRequirements) {
      log.info("x402_challenge_emitted", { run_id, op: body.op, scheme: paymentRequirements.scheme, network: paymentRequirements.network, amount: paymentRequirements.amount });
      return c.json(
        {
          x402Version: 2,
          error: "X-PAYMENT required",
          resource: new URL(c.req.raw.url).pathname,
          accepts: [paymentRequirements],
        },
        402,
      );
    }
    return errorResponse(c, 401, "x402_verify_failed", x402.error ?? "x402 verify failed", {
      run_id,
      op: body.op,
      frame: body.frame,
    });
  }

  // When the facilitator returns a payer we trust it as the authenticated
  // identity for this run — overrides the IP-hashed default agent. Audit
  // events and D1 inherit this stable wallet-derived id.
  const verifiedAgent = x402.payer
    ? `frames-runtime:${x402.payer}`
    : agent;
  const paymentProtocol: "x402" | "x402v2" | "mpp" = "x402v2";
  const paymentNetwork = paymentRequirements?.network ?? "base";

  // ---------------------------------------------------------------------
  // Agent allowlist — closed by default in production. Set
  // `TICK_ALLOWED_AGENTS=*` to open the gate once x402 billing is wired.
  // Allowlist runs against `verifiedAgent` so x402-verified wallets can be
  // explicitly named without exposing the endpoint to the world.
  // ---------------------------------------------------------------------
  const allow = checkAllowlist(verifiedAgent, c.env?.TICK_ALLOWED_AGENTS);
  if (!allow.allowed) {
    log.warn("run_blocked_by_allowlist", { agent: verifiedAgent, entries: allow.entries });
    return errorResponse(c, 403, "agent_not_allowlisted", allow.reason ?? "agent not allowlisted", {
      agent: verifiedAgent,
      allowlist_entries: allow.entries,
    });
  }

  // ---------------------------------------------------------------------
  // Remaining week-2 wiring (post-verify, still pending):
  //   - dispatch through a RunSession DO instead of running inline
  //   - x402 settle on completion (call settleX402 with actual cost)
  //   - finalizeRun() updates the receipt with tx_hash from settle
  // For now ops execute inline with a free HTTP refetcher — useful for
  // local dev and read-only public-frame `verify`/`refresh` testing.
  // ---------------------------------------------------------------------

  const dispatchArgs: DispatchArgs = {
    body,
    env: c.env,
    run_id,
    agent: verifiedAgent,
    budget,
    started_at,
    idempotencyKey,
    x402Payer: x402.payer,
    x402Resource: new URL(c.req.raw.url).pathname,
    x402PaymentPayload: x402.paymentPayload,
    x402PaymentRequirements: paymentRequirements ?? undefined,
    paymentProtocol,
    paymentNetwork,
  };

  // SSE branch: client opted into a stream by Accept: text/event-stream.
  // Emits a `started` frame immediately + heartbeat every 5s + a terminal
  // `completed` or `error` frame. The op still buffers internally; this gives
  // the client a request-accepted signal + a keep-alive while it waits.
  // Progressive per-event streaming (each tool.invoked as it lands) is a v0.1
  // follow-up — needs an onEvent callback threaded through every op.
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return sseRunResponse(dispatchArgs);
  }

  const outcome = await executeOpDispatch(dispatchArgs);
  if (outcome.kind === "ok") return c.json(outcome.result);
  return errorResponse(c, outcome.status, outcome.code, outcome.message, outcome.details);
});

// ---------------------------------------------------------------------------
// Op dispatch helper — used by both JSON and SSE response paths.
// ---------------------------------------------------------------------------

interface DispatchArgs {
  body: RunInput;
  env: Bindings | undefined;
  run_id: string;
  agent: string;
  budget: string;
  started_at: string;
  idempotencyKey: string | undefined;
  paymentProtocol: "x402" | "x402v2" | "mpp";
  paymentNetwork: string;
  /** Verified payer address from x402 verify, when present. Drives settle. */
  x402Payer?: string;
  /** Resource path (e.g. "/run") used as the settle target. */
  x402Resource: string;
  /** Decoded payment payload — passed back to settleX402 unchanged. */
  x402PaymentPayload?: PaymentPayload;
  /** PaymentRequirements quoted to the client — passed back to settleX402 unchanged. */
  x402PaymentRequirements?: PaymentRequirements;
  /**
   * Optional progressive-event callback — populated by the SSE response path
   * so each frame event lands on the wire the moment the op emits it.
   */
  onEvent?: (event: import("@frames-ag/tick-types").FrameEvent) => void;
}

type DispatchOutcome =
  | { kind: "ok"; result: RunResult & { report?: unknown } }
  | {
      kind: "err";
      status: 400 | 404 | 500;
      code: import("./util/errors").ApiErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };

async function executeOpDispatch(args: DispatchArgs): Promise<DispatchOutcome> {
  const { body, env, run_id, agent, budget, started_at, idempotencyKey, paymentProtocol, paymentNetwork } = args;

  if (body.op === "curate" || body.op === "discover") {
    const hasByok = !!(env?.AI_GATEWAY_URL && env?.AI_GATEWAY_BYOK_ALIAS);
    const hasPassthroughKey = !!env?.ANTHROPIC_API_KEY;
    if (!hasByok && !hasPassthroughKey) {
      return {
        kind: "err",
        status: 400,
        code: "missing_llm_auth",
        message: `${body.op} requires either (a) AI Gateway BYOK mode: AI_GATEWAY_URL + AI_GATEWAY_BYOK_ALIAS, or (b) passthrough mode: ANTHROPIC_API_KEY. verify/refresh don't need an LLM key.`,
        details: { run_id, op: body.op, frame: body.frame, started_at, ended_at: new Date().toISOString() },
      };
    }
    const db = env?.DB;
    await persistOpen(db, {
      run_id,
      op: body.op,
      frame: body.frame,
      agent,
      budget,
      started_at,
      idempotency_key: idempotencyKey,
      payment_protocol: paymentProtocol,
      payment_network: paymentNetwork,
    });

    try {
      const refetcher = await pickRefetcher(env);
      const llm = new LlmClient({
        gatewayUrl: env!.AI_GATEWAY_URL,
        gatewayToken: env!.AI_GATEWAY_TOKEN,
        byokAlias: env!.AI_GATEWAY_BYOK_ALIAS,
        anthropicApiKey: env!.ANTHROPIC_API_KEY,
        anthropicBaseUrl: env!.ANTHROPIC_BASE_URL,
        gatewayMetadata: { runId: run_id, op: body.op, wallet: agent },
      });
      // Extract optional customer prompt from body.params. Hard-cap the size
      // so a malformed/oversized prompt can't blow the LLM context budget or
      // the request log.
      const customerPromptRaw = (body.params as { customer_prompt?: unknown } | undefined)?.customer_prompt;
      const customerPrompt =
        typeof customerPromptRaw === "string" && customerPromptRaw.length > 0
          ? customerPromptRaw.slice(0, 32 * 1024) // 32 KiB ceiling — plenty for prompts, prevents DoS
          : undefined;
      if (customerPrompt) {
        log.info("customer_prompt_attached", { run_id, length: customerPrompt.length });
      }

      const sharedLlmOpts = {
        frame_url: body.frame,
        budget,
        run_id,
        agent,
        refetcher,
        client: new FrameClient({ base: env?.FRAMES_CLOUD_BASE }),
        catalog: new CatalogClient({ base: env?.CATALOG_BASE }),
        llm,
        env,
        onEvent: args.onEvent,
        custom_prompt: customerPrompt,
      };
      const outcome =
        body.op === "curate" ? await curateOp(sharedLlmOpts) : await discoverOp(sharedLlmOpts);
      const ended_at = new Date().toISOString();
      const settled = sumCosts(outcome.tool_log.map((t) => t.cost));

      const settleResult = await attemptSettle(args, settled);
      await persistFinalize(db, run_id, {
        outcome,
        settled,
        ended_at,
        status: "completed",
        payment_tx_hash: settleResult.tx_hash,
      });

      return {
        kind: "ok",
        result: {
          run_id,
          op: body.op,
          frame: body.frame,
          settled,
          events: outcome.events,
          tool_log: outcome.tool_log,
          summary: outcome.summary,
          started_at,
          ended_at,
          report: outcome.report,
        },
      };
    } catch (e) {
      const ended_at = new Date().toISOString();
      const message = (e as Error).message;
      await persistError(db, run_id, { ended_at, error: message });
      return {
        kind: "err",
        status: 500,
        code: "op_failed",
        message,
        details: { run_id, op: body.op, frame: body.frame, started_at, ended_at },
      };
    }
  }

  if (body.op === "verify" || body.op === "refresh") {
    const db = env?.DB;
    await persistOpen(db, {
      run_id,
      op: body.op,
      frame: body.frame,
      agent,
      budget,
      started_at,
      idempotency_key: idempotencyKey,
      payment_protocol: paymentProtocol,
      payment_network: paymentNetwork,
    });

    try {
      const refetcher = await pickRefetcher(env);
      const sharedOpts = {
        frame_url: body.frame,
        budget,
        run_id,
        agent,
        refetcher,
        client: new FrameClient({ base: env?.FRAMES_CLOUD_BASE }),
        onEvent: args.onEvent,
      };
      const outcome: OpOutcome = body.op === "verify" ? await verifyOp(sharedOpts) : await refreshOp(sharedOpts);
      const ended_at = new Date().toISOString();
      const settled = sumCosts(outcome.tool_log.map((t) => t.cost));

      const settleResult = await attemptSettle(args, settled);
      await persistFinalize(db, run_id, {
        outcome,
        settled,
        ended_at,
        status: "completed",
        payment_tx_hash: settleResult.tx_hash,
      });

      return {
        kind: "ok",
        result: {
          run_id,
          op: body.op,
          frame: body.frame,
          settled,
          events: outcome.events,
          tool_log: outcome.tool_log,
          summary: outcome.summary,
          started_at,
          ended_at,
          report: outcome.report,
        },
      };
    } catch (e) {
      const ended_at = new Date().toISOString();
      const message = e instanceof FrameClientError ? `${e.code}: ${e.message}` : (e as Error).message;
      await persistError(db, run_id, { ended_at, error: message });
      const code = e instanceof FrameClientError && e.status === 404 ? "frame_unreachable" : "op_failed";
      const status = e instanceof FrameClientError && e.status ? (e.status as 400 | 404 | 500) : 500;
      return {
        kind: "err",
        status,
        code,
        message,
        details: { run_id, op: body.op, frame: body.frame, started_at, ended_at },
      };
    }
  }

  const ended_at = new Date().toISOString();
  return {
    kind: "err",
    status: 500,
    code: "unhandled_op",
    message: `Unhandled op: ${body.op}`,
    details: { run_id, op: body.op, started_at, ended_at },
  };
}

// ---------------------------------------------------------------------------
// Settle helper — call after a successful op outcome. Skips silently when:
//   - no facilitator configured (dev mode)
//   - no payer captured at verify time (no payment header was sent)
//   - actual settled cost is zero (no paid tool calls happened)
//
// Returns the tx_hash for receipt persistence. Settlement failures are logged
// but don't fail the op; the customer already got their work, and operators
// have the run row + tool_log to reconcile manually.
// ---------------------------------------------------------------------------

async function attemptSettle(
  args: DispatchArgs,
  settled: string,
): Promise<{ tx_hash?: string }> {
  const facilitatorUrl = args.env?.FACILITATOR_URL;
  if (!facilitatorUrl) return {};
  if (!args.x402PaymentPayload || !args.x402PaymentRequirements) {
    // Verify ran in optional mode (no header sent), nothing to settle.
    return {};
  }
  if (Number(settled) <= 0) {
    log.info("settle_skipped_zero_cost", { run_id: args.run_id });
    return {};
  }
  const result = await settleX402(
    facilitatorUrl,
    args.x402PaymentPayload,
    args.x402PaymentRequirements,
  );
  if (!result.ok) {
    log.error("settle_failed", { run_id: args.run_id, error: result.error, settled });
    return {};
  }
  return { tx_hash: result.transaction };
}

// ---------------------------------------------------------------------------
// SSE response — emits `started` immediately, `heartbeat` every 5s, then a
// terminal `completed` (data: RunResult) or `error` (data: ApiError) frame.
// ---------------------------------------------------------------------------

function sseRunResponse(args: DispatchArgs): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Stream may already be closed by the consumer; mark and stop.
          closed = true;
        }
      };

      // 1. `started` — client knows the request was accepted and which run_id to poll.
      send("started", {
        run_id: args.run_id,
        op: args.body.op,
        frame: args.body.frame,
        agent: args.agent,
        budget: args.budget,
        started_at: args.started_at,
      });

      // 2. Heartbeat every 5s so middleboxes don't close the connection.
      heartbeat = setInterval(() => {
        send("heartbeat", { ts: new Date().toISOString(), run_id: args.run_id });
      }, 5_000);

      // 3. Run the op with a progressive-event callback. Each frame event
      // emitted by the op lands on the wire as a `frame_event` SSE frame
      // the moment it happens — no buffering until completion.
      const argsWithSse: DispatchArgs = {
        ...args,
        onEvent: (event) => send("frame_event", event),
      };
      executeOpDispatch(argsWithSse)
        .then((outcome) => {
          if (heartbeat) clearInterval(heartbeat);
          if (outcome.kind === "ok") {
            send("completed", outcome.result);
          } else {
            send("error", {
              error: { code: outcome.code, message: outcome.message },
              status: outcome.status,
              ...(outcome.details ?? {}),
            });
          }
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* already closed */ }
          }
        })
        .catch((e) => {
          if (heartbeat) clearInterval(heartbeat);
          send("error", {
            error: { code: "internal", message: (e as Error).message },
            status: 500,
            run_id: args.run_id,
          });
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* already closed */ }
          }
        });
    },
    // Consumer aborted (client closed the connection mid-stream). Clean up
    // the heartbeat so we don't pump events into a dropped socket. The op
    // itself keeps running to completion — receipts still persist to D1 even
    // if the client never sees the `completed` event.
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function sumCosts(costs: string[]): string {
  let total = 0;
  for (const c of costs) total += Number(c);
  return total.toFixed(6);
}

// ---------------------------------------------------------------------------
// Refetcher selection — paid when wallet secrets are present, free otherwise.
//
// The booted wallet stack is cached at module level (per CF Worker isolate).
// CF Workers reuse modules across requests in the same isolate, so we only
// pay the keypair-decode + wallet-construct cost once per cold start.
//
// Falls back to the free httpRefetcher when:
//   - no wallet secrets set (e.g., bun --hot dev, smoketest)
//   - bootWallets throws (e.g., malformed JSON keypair)
// ---------------------------------------------------------------------------

let cachedWallets: Promise<BootedWallets | null> | null = null;

async function pickRefetcher(env: Bindings | undefined): Promise<Refetcher> {
  if (!env) return createHttpRefetcher();

  const hasAnyWalletSecret =
    !!(env.SOLANA_OUTBOUND_KEYPAIR_JSON || env.EVM_OUTBOUND_PRIVATE_KEY);
  if (!hasAnyWalletSecret) return createHttpRefetcher();

  if (!cachedWallets) {
    cachedWallets = bootWallets(env).catch((e) => {
      console.error("bootWallets failed; falling back to free refetcher:", e);
      return null;
    });
  }
  const wallets = await cachedWallets;
  if (!wallets) return createHttpRefetcher();

  return createPaidRefetcher({ paidFetch: wallets.paidFetch });
}

// ---------------------------------------------------------------------------
// Persistence helpers — best-effort. If db is undefined (bun --hot dev), no-op.
// If a write fails, we log to the console and swallow so the user still gets
// a working response. Receipts are nice-to-have; the request flow is the SLA.
// ---------------------------------------------------------------------------

async function persistOpen(
  db: D1Database | undefined,
  args: {
    run_id: string;
    op: Op;
    frame: string;
    agent: string;
    budget: string;
    started_at: string;
    idempotency_key?: string | null;
    payment_protocol?: "x402" | "x402v2" | "mpp";
    payment_network?: string;
  },
): Promise<void> {
  if (!db) return;
  try {
    await insertRun(db, {
      ...args,
      settled: "0",
      status: "running",
      payment_protocol: args.payment_protocol ?? "x402v2",
      payment_network: args.payment_network ?? "base",
    });
  } catch (e) {
    log.error("persistOpen_failed", { run_id: args.run_id, error: (e as Error).message });
  }
}

async function persistFinalize(
  db: D1Database | undefined,
  run_id: string,
  args: {
    outcome: { events: import("@frames-ag/tick-types").FrameEvent[]; tool_log: import("@frames-ag/tick-types").ToolCall[] };
    settled: string;
    ended_at: string;
    status: "completed" | "failed" | "aborted";
    payment_tx_hash?: string;
  },
): Promise<void> {
  if (!db) return;
  try {
    // Single round-trip: D1 batches every prepared statement and commits them
    // as one atomic transaction. A 30-event / 10-tool-call run goes from ~41
    // sequential network round-trips to one.
    const stmts: D1PreparedStatement[] = [];

    for (let i = 0; i < args.outcome.tool_log.length; i++) {
      const call = args.outcome.tool_log[i]!;
      stmts.push(
        db
          .prepare(
            `INSERT INTO tool_calls (run_id, seq, descriptor_id, tool_id, cost, source_url, retrieved_at, input_hash, response_size_bytes, duration_ms, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            run_id,
            i,
            call.descriptor_id,
            call.tool_id,
            call.cost,
            call.source_url ?? null,
            call.retrieved_at,
            call.input_hash,
            (call as { response_size_bytes?: number }).response_size_bytes ?? null,
            (call as { duration_ms?: number }).duration_ms ?? null,
            (call as { error?: string }).error ?? null,
          ),
      );
    }

    for (let i = 0; i < args.outcome.events.length; i++) {
      const ev = args.outcome.events[i]!;
      const entityId = extractEntityId(ev);
      stmts.push(
        db
          .prepare(
            `INSERT INTO events (event_id, run_id, seq, ts, type, agent, entity_id, payload, emitted_to_frame)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            ev.id,
            run_id,
            i,
            ev.ts,
            ev.type,
            ev.agent,
            entityId,
            JSON.stringify(ev.payload),
            0,
          ),
      );
    }

    stmts.push(
      db
        .prepare(
          `UPDATE runs
           SET status = ?, settled = ?, ended_at = ?, summary = ?, error = ?, payment_tx_hash = ?, payment_intent_id = ?
           WHERE run_id = ?`,
        )
        .bind(args.status, args.settled, args.ended_at, null, null, args.payment_tx_hash ?? null, null, run_id),
    );

    await db.batch(stmts);
  } catch (e) {
    log.error("persistFinalize_failed", { run_id, error: (e as Error).message });
    // Fall back to sequential writes if the batch failed — best-effort recovery
    // so we still get a partial receipt rather than losing the whole run.
    try {
      for (let i = 0; i < args.outcome.tool_log.length; i++) {
        await insertToolCall(db, run_id, i, args.outcome.tool_log[i]!);
      }
      for (let i = 0; i < args.outcome.events.length; i++) {
        const ev = args.outcome.events[i]!;
        await insertEvent(db, run_id, i, ev, extractEntityId(ev), false);
      }
      await finalizeRun(db, run_id, {
        status: args.status,
        settled: args.settled,
        ended_at: args.ended_at,
        payment_tx_hash: args.payment_tx_hash,
      });
    } catch (e2) {
      log.error("persistFinalize_fallback_failed", { run_id, error: (e2 as Error).message });
    }
  }
}

async function persistError(
  db: D1Database | undefined,
  run_id: string,
  args: { ended_at: string; error: string },
): Promise<void> {
  if (!db) return;
  try {
    await finalizeRun(db, run_id, {
      status: "failed",
      settled: "0",
      ended_at: args.ended_at,
      error: args.error,
    });
  } catch (e) {
    log.error("persistError_failed", { run_id, error: (e as Error).message });
  }
}

function extractEntityId(ev: import("@frames-ag/tick-types").FrameEvent): string | null {
  const p = ev.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (typeof p.entity_id === "string") return p.entity_id;
  return null;
}

// ---------------------------------------------------------------------------
// Read endpoints
//
// `/runs/:id`  — receipt for a specific run. Public by `run_id` possession
//                (run_ids are opaque UUIDs). Anyone holding the id can audit.
// `/history`   — runs by wallet address. Requires SIWX signature gating;
//                week-5 ships a real CAIP-122 verifier. For now, requires
//                an explicit `?address=` and returns 401 without one.
// `/balance`   — wallet outbound balance summary. For now, returns the
//                configured outbound chain status from env; on-chain balance
//                lookup ships when we wire RPC clients for read-side.
// ---------------------------------------------------------------------------

// DELETE /runs/:id — mark a run as aborted. Doesn't settle. Best-effort: the
// in-flight op may have already started spending; this just stops new tool
// calls and surfaces an aborted status in the receipt. Real mid-flight
// cancellation needs the agent loop to check a kill switch each iteration —
// week-4 work tied to the DO-based RunSession.
app.delete("/runs/:id", async (c) => {
  if (!c.env?.DB) return errorResponse(c, 503, "no_db_binding", "D1 binding not configured");
  const run_id = c.req.param("id");
  const run = await getRun(c.env.DB, run_id);
  if (!run) return errorResponse(c, 404, "not_found", `run not found: ${run_id}`, { run_id });
  if (run.status === "completed" || run.status === "aborted" || run.status === "failed") {
    return c.json({ run_id, status: run.status, note: "terminal state; nothing to abort" });
  }
  await finalizeRun(c.env.DB, run_id, {
    status: "aborted",
    settled: run.settled,
    ended_at: new Date().toISOString(),
  });
  return c.json({ run_id, status: "aborted" });
});

app.get("/runs/:id", async (c) => {
  if (!c.env?.DB) return errorResponse(c, 503, "no_db_binding", "D1 binding not configured on this Worker");
  const run_id = c.req.param("id");
  const run = await getRun(c.env.DB, run_id);
  if (!run) return errorResponse(c, 404, "not_found", `run not found: ${run_id}`, { run_id });
  const events = await getRunEvents(c.env.DB, run_id);
  const tool_calls = await getRunToolCalls(c.env.DB, run_id);
  return c.json({
    run_id: run.run_id,
    op: run.op,
    frame: run.frame,
    agent: run.agent,
    status: run.status,
    settled: run.settled,
    budget: run.budget,
    started_at: run.started_at,
    ended_at: run.ended_at,
    summary: run.summary,
    error: run.error,
    region: run.region,
    payment: {
      protocol: run.payment_protocol,
      network: run.payment_network,
      tx_hash: run.payment_tx_hash,
      intent_id: run.payment_intent_id,
    },
    events: events.map((e) => ({
      id: e.event_id,
      ts: e.ts,
      type: e.type,
      agent: e.agent,
      run_id: e.run_id,
      payload: safeParseJson(e.payload),
      emitted_to_frame: !!e.emitted_to_frame,
    })),
    tool_log: tool_calls.map((t) => ({
      seq: t.seq,
      descriptor_id: t.descriptor_id,
      tool_id: t.tool_id,
      cost: t.cost,
      source_url: t.source_url,
      retrieved_at: t.retrieved_at,
      input_hash: t.input_hash,
      duration_ms: t.duration_ms,
      response_size_bytes: t.response_size_bytes,
      error: t.error,
    })),
  });
});

app.get("/history", async (c) => {
  if (!c.env?.DB) return errorResponse(c, 503, "no_db_binding", "D1 binding not configured on this Worker");
  const address = c.req.query("address");
  // TODO: replace ?address= with real SIWX/CAIP-122 signature verification.
  // For now, we accept an explicit address but never publish private metadata.
  // A spoofed address returns runs that match — they're already visible via /runs/:id
  // to anyone with the run_id, so this is not a leak vector, just an unauth'd index.
  if (!address) {
    return errorResponse(
      c,
      401,
      "address_required",
      "Provide ?address=<wallet> to list runs. SIWX signature gating ships later.",
    );
  }
  const limit = Math.min(100, parseInt(c.req.query("limit") ?? "20", 10) || 20);
  // The agent column stores `frames-runtime:<address>`; accept either the bare
  // address or the prefixed form. Normalize to the prefixed form for the query.
  const agent = address.startsWith("frames-runtime:") ? address : `frames-runtime:${address}`;
  const runs = await listRunsByAgent(c.env.DB, agent, limit);
  return c.json({
    address,
    agent,
    limit,
    runs: runs.map((r) => ({
      run_id: r.run_id,
      op: r.op,
      frame: r.frame,
      status: r.status,
      settled: r.settled,
      started_at: r.started_at,
      ended_at: r.ended_at,
      summary: r.summary,
    })),
  });
});

// DELETE /history?address=<wallet> — purge all runs (and cascading
// tool_calls + events) for a given agent. GDPR / right-to-erasure.
//
// Auth ladder, weakest first:
//   1. No FACILITATOR_URL  → open endpoint (dev). Anyone can purge any address.
//                            Caller still has to supply ?address= so we don't
//                            accidentally wipe everything.
//   2. FACILITATOR_URL set → require an x402 payment header. The verified
//                            payer must match the target address. Third
//                            parties can no longer purge someone else's
//                            history even if they know the address.
//   3. Post-SIWX (future)  → require a CAIP-122 signed message from the
//                            target address itself. Replaces (2).
app.delete("/history", async (c) => {
  if (!c.env?.DB) return errorResponse(c, 503, "no_db_binding", "D1 binding not configured");
  const address = c.req.query("address");
  if (!address) {
    return errorResponse(c, 401, "address_required", "Provide ?address=<wallet> to purge runs. Real SIWX gating ships later.");
  }

  // Strict mode: when FACILITATOR_URL is set, verify the payment header and
  // require the payer to match the address being purged. We use a tiny
  // zero-cost PaymentRequirements as the proof-of-identity vehicle — the
  // facilitator verifies the signature, we don't actually settle anything.
  if (c.env.FACILITATOR_URL && c.env.TICK_PAY_TO_ADDRESS) {
    const purgeRequirements: PaymentRequirements = {
      scheme: c.env.TICK_PAY_SCHEME ?? "erc3009",
      network: c.env.TICK_PAY_NETWORK ?? "base",
      amount: "0",
      asset: c.env.TICK_PAY_ASSET ?? "",
      payTo: c.env.TICK_PAY_TO_ADDRESS,
      maxTimeoutSeconds: 30,
    };
    const x402 = await verifyInboundX402(c.req.raw, c.env.FACILITATOR_URL, purgeRequirements, {
      optional: false,
    });
    if (!x402.ok) {
      return errorResponse(c, 401, "x402_verify_failed", x402.error ?? "x402 verify failed for /history DELETE");
    }
    if (!x402.payer || x402.payer !== address) {
      return errorResponse(c, 403, "x402_verify_failed", "Verified payer does not match ?address=. You may only purge your own runs.", {
        verified_payer: x402.payer,
        target_address: address,
      });
    }
  }

  const agent = address.startsWith("frames-runtime:") ? address : `frames-runtime:${address}`;
  const { deleted } = await purgeRunsByAgent(c.env.DB, agent);
  log.info("history_purged", { agent, deleted });
  return c.json({ address, agent, deleted });
});

app.get("/balance", (c) => {
  // On-chain balance lookups (USDC on Solana / Base / Tempo) ship later;
  // they require RPC client wiring per chain. For now, surface the operator
  // wallet's configured-chain status so customers can confirm the runtime is
  // wallet-equipped without exposing keys or addresses.
  return c.json({
    note: "On-chain balance lookups ship after RPC client wiring. This endpoint currently surfaces wallet-configuration state only.",
    wallets: {
      solana_configured: !!(c.env?.SOLANA_OUTBOUND_KEYPAIR_JSON && c.env?.SOLANA_RPC_URL),
      evm_configured: !!c.env?.EVM_OUTBOUND_PRIVATE_KEY,
      tempo_configured: !!c.env?.EVM_OUTBOUND_PRIVATE_KEY, // same key as EVM
    },
  });
});

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export default app;
