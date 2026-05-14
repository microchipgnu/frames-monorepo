// Vercel AI SDK-backed LLM client (Phase 2 — replaces hand-rolled client.ts).
//
// Why the swap:
//   - The hand-rolled client.ts was 693 lines of provider-routing + format-
//     translation: Anthropic Messages API, Workers AI OpenAI-compat, env.AI
//     binding, gateway URL building, cost computation, retry, etc.
//   - Adding non-Anthropic providers (OpenAI, Google, Grok) would have meant
//     adding another ~300 lines per provider — auth, request shape, response
//     shape, tool-call translation.
//   - Vercel AI SDK + ai-gateway-provider does all of that uniformly. Every
//     model becomes a string. Adding a provider is `npm install @ai-sdk/foo`.
//
// What's preserved:
//   - Public types: LlmRole, LlmContent, LlmMessage, LlmToolSpec, LlmUsage,
//     LlmResponse, CallOptions, LlmClientConfig, LlmError. All ~10 call sites
//     continue to use `await llm.call({system, messages, tools, agent})`.
//
// What's removed:
//   - ~500 lines of provider-specific request/response handling.
//   - The model price table — Vercel SDK exposes usage; CF AI Gateway bills
//     us in USDC directly. No need to compute estimated_cost from price
//     tables; usage tokens still propagate for diagnostics.

import { generateText, type ModelMessage, tool as aiTool, jsonSchema } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { createAnthropic } from "@ai-sdk/anthropic";

// ---------- Public types (UNCHANGED from client.ts) -------------------------

export type LlmRole = "user" | "assistant";

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: LlmRole;
  content: LlmContent[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * Estimated USDC cost. With CF AI Gateway billing the account directly,
   * this is now best-effort from tokens — no longer authoritative. Kept
   * for diagnostic continuity with the prior shape; "0" when unknown.
   */
  estimated_cost: string;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface LlmResponse {
  stop_reason: string;
  content: LlmContent[];
  usage: LlmUsage;
  model: string;
}

export interface CallOptions {
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  max_tokens?: number;
  agent?: "title" | "build" | "explore";
  model?: string;
}

export interface LlmClientConfig {
  /**
   * Cloudflare AI Gateway URL. We parse `accountId` + `gatewaySlug` out of
   * it (`https://gateway.ai.cloudflare.com/v1/<account>/<slug>`). When unset
   * we fall back to Anthropic direct via passthrough.
   */
  gatewayUrl?: string;
  /** AI Gateway auth token (cf-aig-authorization). */
  gatewayToken?: string;
  /** Gateway slug shortcut when gatewayUrl is not set. */
  aiGatewaySlug?: string;
  /** CF account id (parsed from gatewayUrl when present; explicit for fallback). */
  cfAccountId?: string;
  /** BYOK alias (gateway-side stored key). When unset, falls back to provider-direct keys. */
  byokAlias?: string;
  /** Passthrough Anthropic API key — used only when running outside the gateway (local dev). */
  anthropicApiKey?: string;
  /** Per-agent default models. All accepted: `anthropic/*`, `openai/*`, `google/*`, `@cf/*`. */
  buildModel?: string;
  titleModel?: string;
  exploreModel?: string;
  /**
   * Global model override. When set, every call uses this model regardless
   * of `agent`. Name kept for compatibility with env.WORKERS_AI_MODEL; any
   * gateway-supported model id works (not limited to Workers AI).
   */
  workersAiModel?: string;
  /** Metadata attached to every call (AI Gateway analytics). */
  gatewayMetadata?: Record<string, unknown>;
  /**
   * Cloudflare Workers AI binding (`env.AI`). Required to route `@cf/*`
   * models — those go directly through the binding (CF runs the model on
   * Workers AI infrastructure, no upstream provider needed). CF AI Gateway
   * compat endpoint does NOT accept `@cf/*` ids; this binding is the only
   * supported path. When unset, `@cf/*` model requests throw LlmError.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ai?: any;
}

export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
  }
}

// ---------- Implementation --------------------------------------------------

export class LlmClient {
  private cfg: LlmClientConfig;

  constructor(cfg: LlmClientConfig) {
    this.cfg = {
      buildModel: "anthropic/claude-sonnet-4-6",
      titleModel: "anthropic/claude-haiku-4-5",
      exploreModel: "anthropic/claude-sonnet-4-6",
      ...cfg,
    };
  }

  async call(opts: CallOptions): Promise<LlmResponse> {
    const modelId = opts.model ?? this.pickModel(opts.agent ?? "build");

    // `@cf/*` models — Workers AI catalog. The CF AI Gateway compat
    // endpoint rejects most `@cf/*` ids (confirmed 2026-05-14 via wrangler
    // tail on both `@cf/openai/gpt-oss-20b` and `workers-ai/@cf/...` —
    // both 400 Bad Request). The reliable path is env.AI.run() directly,
    // optionally with `gateway: { id }` for observability.
    if (modelId.startsWith("@cf/")) {
      return this.callWorkersAi(modelId, opts);
    }

    // Three routing paths. The choice matters for prompt caching:
    //   1. Anthropic via CF Gateway NATIVE endpoint (`/anthropic`): the
    //      @ai-sdk/anthropic provider speaks Anthropic's native API and
    //      preserves `cache_control` on messages/tools. THIS is what makes
    //      prompt caching work in production.
    //   2. Non-Anthropic via CF Gateway compat endpoint (OpenAI-compat).
    //      The `unified` adapter translates to OpenAI's shape; Anthropic-
    //      specific options (like cache_control) get dropped — fine for
    //      openai/*, google/*, @cf/* models which use their own caching.
    //   3. Direct Anthropic (local dev): same SDK as path 1, just no gateway.
    //
    // Why this matters: ai-gateway-provider's `unified` is built on
    // @ai-sdk/openai-compatible. CF Gateway's OpenAI-compat endpoint strips
    // Anthropic's `cache_control`. Routing Anthropic models through native
    // gets us cache hits + observability + BYOK aliasing.
    const gw = this.tryParseGateway();
    const isAnthropicModel = modelId.startsWith("anthropic/");
    let model;
    let routingPath: "anthropic-gateway" | "anthropic-direct" | "unified-gateway";
    if (gw && isAnthropicModel) {
      // CF Gateway BYOK uses a custom header, NOT the upstream provider's
      // standard auth header: `cf-aig-byok-alias: <alias>` tells the gateway
      // to substitute the alias for the stored upstream key before forwarding
      // to Anthropic. The Worker never sees the real key.
      //
      // The SDK still requires `apiKey` (for x-api-key). We pass a placeholder
      // — the gateway strips/ignores it when cf-aig-byok-alias is present.
      // For passthrough (no BYOK) we send the real anthropic key as x-api-key.
      const bareModelId = modelId.replace(/^anthropic\//, "");
      const useByok = !!this.cfg.byokAlias;
      const extraHeaders: Record<string, string> = {};
      if (this.cfg.gatewayToken) {
        extraHeaders["cf-aig-authorization"] = `Bearer ${this.cfg.gatewayToken}`;
      }
      if (useByok) {
        extraHeaders["cf-aig-byok-alias"] = this.cfg.byokAlias!;
      }
      // 1h cache TTL requires the extended-cache-ttl beta header. The SDK
      // accepts `ttl: "1h"` in cacheControl but does NOT add this header
      // automatically — without it Anthropic silently falls back to 5m TTL,
      // which is what was happening on iter 3+ misses.
      extraHeaders["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
      const anthropic = createAnthropic({
        apiKey: useByok ? "byok-placeholder" : (this.cfg.anthropicApiKey ?? ""),
        baseURL: `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewaySlug}/anthropic/v1`,
        headers: extraHeaders,
      });
      model = anthropic(bareModelId);
      routingPath = "anthropic-gateway";
    } else if (gw) {
      const aigateway = createAiGateway({
        accountId: gw.accountId,
        gateway: gw.gatewaySlug,
        apiKey: this.cfg.gatewayToken,
      });
      const unified = this.cfg.byokAlias
        ? createUnified({ apiKey: this.cfg.byokAlias })
        : createUnified();
      model = aigateway(unified(modelId));
      routingPath = "unified-gateway";
    } else if (this.cfg.anthropicApiKey && isAnthropicModel) {
      const anthropic = createAnthropic({
        apiKey: this.cfg.anthropicApiKey,
        // See gateway path above — required for cacheControl ttl: "1h" to
        // be honored. Without this, Anthropic silently falls back to 5m TTL.
        headers: { "anthropic-beta": "extended-cache-ttl-2025-04-11" },
      });
      model = anthropic(modelId.replace(/^anthropic\//, ""));
      routingPath = "anthropic-direct";
    } else {
      throw new LlmError(
        `LlmClient unconfigured: no AI gateway (gatewayUrl / cfAccountId+aiGatewaySlug) and no anthropicApiKey for model ${modelId}.`,
      );
    }

    const messages = mapToModelMessages(opts.messages);
    const tools = mapToTools(opts.tools);

    // Anthropic prompt caching: two breakpoints.
    //   1. SYSTEM message with cacheControl — caches the system prompt + tool
    //      definitions, the largest fully-stable chunk (~5k tokens for our
    //      agent prompts). This anchor is rock-solid: it never moves and
    //      doesn't depend on conversation state.
    //   2. LAST conversation message with cacheControl — caches the prior
    //      messages so successive iters cheaply replay the conversation.
    //
    // We pass system as a system-role message (not via the top-level
    // `system:` param) so it can carry providerOptions. ttl=1h is 2× write
    // rate (vs 1.25× for 5m) but eliminates TTL-miss costs on slower runs;
    // reads stay 0.1× regardless.
    //
    // Only effective on the `anthropic-*` routing paths; the unified compat
    // adapter strips Anthropic-specific provider options.
    const cachingEnabled = routingPath === "anthropic-gateway" || routingPath === "anthropic-direct";
    const finalMessages: ModelMessage[] = cachingEnabled && opts.system
      ? ([
          {
            role: "system",
            content: opts.system,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
          } as any,
          ...messages,
        ])
      : messages;

    if (cachingEnabled && finalMessages.length > 0) {
      const lastIdx = finalMessages.length - 1;
      const last = finalMessages[lastIdx]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (last as any).providerOptions = {
        ...((last as any).providerOptions ?? {}),
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      };
    }

    let result;
    try {
      result = await generateText({
        model,
        // When caching is on, system is passed as a system-role message in
        // `messages` (so it can carry cacheControl). Otherwise via the
        // top-level field.
        ...(cachingEnabled ? {} : { system: opts.system }),
        messages: finalMessages,
        tools,
        // We dispatch tools ourselves — let the model produce the tool_calls
        // and stop, don't let the SDK auto-execute (no `execute` on our tools).
        // `toolChoice: "auto"` is the SDK default; explicit for clarity.
        toolChoice: tools ? "auto" : undefined,
        maxOutputTokens: opts.max_tokens,
        // Don't let the SDK auto-step into a multi-turn loop — we manage that.
        stopWhen: undefined,
      });
    } catch (e) {
      // Log the FULL error before wrapping so we can see provider responses
      // in wrangler tail. The wrapped LlmError loses stack + nested details.
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const stack = e instanceof Error ? e.stack?.slice(0, 1000) : undefined;
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          event: "llm_call_failed",
          model: modelId,
          path: routingPath,
          gateway_slug: gw?.gatewaySlug,
          error: errMsg,
          stack,
        }),
      );
      throw new LlmError(`LLM call failed (${modelId}): ${errMsg}`);
    }

    return mapResponse(result, modelId);
  }

  private pickModel(agent: "title" | "build" | "explore"): string {
    if (this.cfg.workersAiModel) return this.cfg.workersAiModel;
    if (agent === "title") return this.cfg.titleModel!;
    if (agent === "explore") return this.cfg.exploreModel!;
    return this.cfg.buildModel!;
  }

  /**
   * Call a Workers AI (`@cf/*`) model via the `env.AI` binding. Bypasses the
   * Vercel SDK entirely — translates our `LlmMessage[]` shape into the
   * OpenAI-compatible chat-completions body that env.AI accepts for chat
   * models, then translates the response back into LlmResponse.
   *
   * Routes through the AI Gateway when `aiGatewaySlug` is set (for logging
   * + cost tracking in the gateway dashboard).
   */
  private async callWorkersAi(modelId: string, opts: CallOptions): Promise<LlmResponse> {
    if (!this.cfg.ai) {
      throw new LlmError(`@cf/* model "${modelId}" requires env.AI binding, but none was provided to LlmClient`);
    }

    // Translate LlmMessage[] → OpenAI chat-completions messages.
    // System goes first; user/assistant/tool messages follow.
    interface OAMsg {
      role: "system" | "user" | "assistant" | "tool";
      content: string | null;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
    const messages: OAMsg[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    for (const m of opts.messages) {
      if (m.role === "user") {
        const textParts = m.content.filter((c): c is Extract<LlmContent, { type: "text" }> => c.type === "text");
        const toolResults = m.content.filter((c): c is Extract<LlmContent, { type: "tool_result" }> => c.type === "tool_result");
        if (textParts.length > 0) {
          messages.push({ role: "user", content: textParts.map((c) => c.text).join("\n") });
        }
        for (const tr of toolResults) {
          messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
        }
      } else {
        // assistant
        const textParts = m.content.filter((c): c is Extract<LlmContent, { type: "text" }> => c.type === "text");
        const toolUses = m.content.filter((c): c is Extract<LlmContent, { type: "tool_use" }> => c.type === "tool_use");
        const text = textParts.map((c) => c.text).join("");
        const tool_calls = toolUses.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
        messages.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        });
      }
    }

    const body: Record<string, unknown> = {
      messages,
      max_tokens: opts.max_tokens ?? 4096,
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      body.tool_choice = "auto";
    }

    const gatewayOpts = this.cfg.aiGatewaySlug
      ? { gateway: { id: this.cfg.aiGatewaySlug } }
      : undefined;

    let json: {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json = (await (this.cfg.ai as any).run(modelId, body, gatewayOpts)) as typeof json;
    } catch (e) {
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          event: "llm_call_failed",
          model: modelId,
          path: "workers-ai-binding",
          error: errMsg,
        }),
      );
      throw new LlmError(`Workers AI call failed (${modelId}): ${errMsg}`);
    }

    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new LlmError(`Workers AI returned no choice for ${modelId}`);
    }

    const content: LlmContent[] = [];
    if (typeof choice.message.content === "string" && choice.message.content.length > 0) {
      content.push({ type: "text", text: choice.message.content });
    }
    for (const tc of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }

    let stop_reason = "end_turn";
    switch (choice.finish_reason) {
      case "stop": stop_reason = "end_turn"; break;
      case "tool_calls": stop_reason = "tool_use"; break;
      case "length": stop_reason = "max_tokens"; break;
      case "content_filter": stop_reason = "stop_sequence"; break;
      default: stop_reason = choice.finish_reason ?? "end_turn";
    }

    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    const estimatedCost = computeCost(modelId, {
      input: inputTokens,
      output: outputTokens,
      cacheCreation: 0,
      cacheRead: 0,
    });

    return {
      stop_reason,
      content,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        estimated_cost: estimatedCost,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model: modelId,
    };
  }

  /**
   * Try to resolve the AI Gateway accountId + gatewaySlug from the configured
   * fields. Returns null when neither path is available (caller falls back to
   * direct provider mode).
   */
  private tryParseGateway(): { accountId: string; gatewaySlug: string } | null {
    if (this.cfg.cfAccountId && this.cfg.aiGatewaySlug) {
      return { accountId: this.cfg.cfAccountId, gatewaySlug: this.cfg.aiGatewaySlug };
    }
    if (this.cfg.gatewayUrl) {
      const m = this.cfg.gatewayUrl.match(/gateway\.ai\.cloudflare\.com\/v1\/([^/]+)\/([^/?#]+)/);
      if (m) return { accountId: m[1]!, gatewaySlug: m[2]! };
    }
    return null;
  }
}

// ---------- Mapping helpers -------------------------------------------------

/**
 * Map our LlmMessage[] (Anthropic-shaped: text + tool_use + tool_result
 * blocks in a single message) → Vercel AI SDK ModelMessage[] (separates
 * tool results into their own role="tool" messages).
 */
function mapToModelMessages(messages: LlmMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      // Split user message: tool_result blocks → tool role; text → user text.
      const toolResults = msg.content.filter((c): c is Extract<LlmContent, { type: "tool_result" }> => c.type === "tool_result");
      const textBlocks = msg.content.filter((c): c is Extract<LlmContent, { type: "text" }> => c.type === "text");
      if (toolResults.length > 0) {
        out.push({
          role: "tool",
          content: toolResults.map((t) => ({
            type: "tool-result",
            toolCallId: t.tool_use_id,
            toolName: "", // filled by SDK from the call list
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            output: { type: "text", value: t.content } as any,
          })),
        });
      }
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b) => b.text).join("\n");
        out.push({ role: "user", content: text });
      } else if (toolResults.length === 0) {
        out.push({ role: "user", content: "" });
      }
      continue;
    }
    if (msg.role === "assistant") {
      // Assistant message: keep text + tool_use blocks together.
      const parts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
      for (const c of msg.content) {
        if (c.type === "text") parts.push({ type: "text", text: c.text });
        else if (c.type === "tool_use") parts.push({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.input });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out.push({ role: "assistant", content: parts as any });
      continue;
    }
  }
  return out;
}

/**
 * Map our LlmToolSpec[] → Vercel SDK ToolSet. We don't set `execute` — we
 * dispatch tools ourselves at the call site (curate.ts, refresh-entity.ts,
 * etc.). The SDK returns tool_calls in the response for us to handle.
 */
function mapToTools(tools: LlmToolSpec[] | undefined): Record<string, ReturnType<typeof aiTool>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: Record<string, ReturnType<typeof aiTool>> = {};
  for (const t of tools) {
    // Wrap raw JSON Schema in the SDK's `jsonSchema()` helper. Passing the
    // raw schema object directly fails at call time with
    // `TypeError: schema2 is not a function` inside the SDK's `asSchema`.
    // The helper produces a SchemaV1 the SDK can introspect.
    out[t.name] = aiTool({
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: jsonSchema(t.input_schema as any),
      // No `execute` — we handle dispatch externally.
    });
  }
  return out;
}

/**
 * Map Vercel SDK generateText result → our LlmResponse shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapResponse(result: any, modelId: string): LlmResponse {
  const content: LlmContent[] = [];

  // Text comes back as `result.text` (single string). Vercel SDK normalizes
  // text segments into one string regardless of how the model interleaved them.
  if (typeof result.text === "string" && result.text.length > 0) {
    content.push({ type: "text", text: result.text });
  }

  // Tool calls come back as `result.toolCalls`. Each has toolCallId, toolName, input.
  if (Array.isArray(result.toolCalls)) {
    for (const tc of result.toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input as Record<string, unknown>) ?? {},
      });
    }
  }

  // Map finish reason. Vercel: "stop" | "tool-calls" | "length" | "content-filter" | "other".
  let stop_reason = "end_turn";
  switch (result.finishReason) {
    case "stop":
      stop_reason = "end_turn";
      break;
    case "tool-calls":
      stop_reason = "tool_use";
      break;
    case "length":
      stop_reason = "max_tokens";
      break;
    case "content-filter":
      stop_reason = "stop_sequence";
      break;
    default:
      stop_reason = result.finishReason ?? "end_turn";
  }

  // Anthropic cache token counts come through providerMetadata in the SDK
  // response. When prompt caching is hit, `cachedInputTokens` represents the
  // tokens read from cache (billed at ~0.1× the input rate). Iteration_log
  // shows these so cache effectiveness is visible per-iter.
  const cacheReadTokens =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.providerMetadata?.anthropic as any)?.cacheReadInputTokens ??
    result.usage?.cachedInputTokens ??
    0;
  const cacheCreationTokens =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.providerMetadata?.anthropic as any)?.cacheCreationInputTokens ?? 0;

  // Vercel AI SDK 6 reports `result.usage.inputTokens` as the TOTAL prompt
  // (non-cached + cache_creation + cache_read). For billing we need just the
  // non-cached portion; the cache buckets are billed separately at their own
  // rates. The SDK exposes `inputTokenDetails.noCacheTokens` for this, but it
  // can be missing on some providers — fall back to total − cache.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u = result.usage as any;
  const totalInputTokens = u?.inputTokens ?? u?.promptTokens ?? 0;
  const noCacheInputTokens =
    u?.inputTokenDetails?.noCacheTokens ??
    Math.max(0, totalInputTokens - cacheCreationTokens - cacheReadTokens);
  const outputTokens = u?.outputTokens ?? u?.completionTokens ?? 0;
  const estimatedCost = computeCost(modelId, {
    input: noCacheInputTokens,
    output: outputTokens,
    cacheCreation: cacheCreationTokens,
    cacheRead: cacheReadTokens,
  });

  const usage: LlmUsage = {
    // We surface the TOTAL input tokens (cache included) here so the
    // iteration_log reads naturally — readers can see the prompt size at a
    // glance, then read cache_creation/cache_read to know how much was billed.
    input_tokens: totalInputTokens,
    output_tokens: outputTokens,
    // Estimated cost in USD. CF AI Gateway is still the authoritative billing
    // source; this is a token-based estimate from the per-model price table
    // below. Used for budget enforcement + iter-log diagnostics.
    estimated_cost: estimatedCost,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  };

  return {
    stop_reason,
    content,
    usage,
    model: result.response?.modelId ?? modelId,
  };
}

// ---------- Pricing --------------------------------------------------------

// USD per 1M tokens, by model id. Prices as of 2026-Q2.
//
// CF AI Gateway has two model categories — both routable via this client:
//   - HOSTED (`@cf/...`): CF runs the model on Workers AI, bills CF rates
//     directly. No upstream provider key needed. Function-calling models
//     are noted in CF's catalog with "Function calling" badge.
//   - PROXIED (`anthropic/`, `google/`, `openai/`, etc.): CF routes to the
//     upstream and bills the user. Most don't need a BYOK alias because
//     CF AI Gateway has marketplace upstream config.
//
// Routing in this client:
//   - `anthropic/*` → @ai-sdk/anthropic + CF Gateway NATIVE Anthropic
//     endpoint. Supports prompt caching (cache_control + ttl=1h beta).
//   - everything else → @ai-sdk/openai-compatible via CF Gateway's
//     `/v1/compat` endpoint. Caching not supported on this path.
//
// Pass via `body.params.model` or `body.params.sub_agent_model` on
// `POST /run` (or via workflow_dispatch inputs `model` / `sub_agent_model`).
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  // ===== Proxied — Anthropic (has prompt caching) =====
  "anthropic/claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "anthropic/claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "anthropic/claude-opus-4-7": { in: 15.0, out: 75.0 },
  // Bare ids (response.modelId after the `anthropic/` prefix is stripped).
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-7": { in: 15.0, out: 75.0 },

  // ===== Proxied — Google Gemini =====
  // CF prefix is `google/` (NOT `google-ai-studio/`); 2026-Q2 lineup is
  // gemini-3-flash / gemini-3.1-pro / gemini-3.1-flash-lite.
  "google/gemini-3-flash": { in: 0.15, out: 0.60 },
  "google/gemini-3.1-flash-lite": { in: 0.08, out: 0.30 },
  "google/gemini-3.1-pro": { in: 1.25, out: 10.0 },

  // ===== Proxied — OpenAI =====
  "openai/gpt-4.1": { in: 2.00, out: 8.00 },
  "openai/gpt-4.1-mini": { in: 0.40, out: 1.60 },
  "openai/o4-mini": { in: 1.10, out: 4.40 },
  "openai/gpt-5.4": { in: 2.50, out: 10.0 },
  "openai/gpt-5.4-mini": { in: 0.30, out: 1.20 },
  "openai/gpt-5.4-nano": { in: 0.10, out: 0.40 },
  "openai/gpt-5.5": { in: 5.00, out: 20.0 },

  // ===== HOSTED on CF Workers AI (no upstream key needed, function-calling) =====
  // All have "Function calling" capability in CF's catalog.
  "@cf/openai/gpt-oss-120b": { in: 0.50, out: 2.00 },
  "@cf/openai/gpt-oss-20b": { in: 0.20, out: 0.80 },
  "@cf/moonshotai/kimi-k2.6": { in: 0.50, out: 2.50 },
  "@cf/moonshotai/kimi-k2.5": { in: 0.50, out: 2.50 },
  "@cf/zai-org/glm-4.7-flash": { in: 0.20, out: 0.80 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 0.30, out: 1.20 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "@cf/google/gemma-4-26b-a4b-it": { in: 0.25, out: 1.00 },
  "@cf/nvidia/nemotron-3-120b-a12b": { in: 0.40, out: 1.60 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 0.30, out: 1.20 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { in: 0.25, out: 1.00 },
  "@cf/ibm-granite/granite-4.0-h-micro": { in: 0.15, out: 0.60 },
};

function computeCost(
  modelId: string,
  tokens: { input: number; output: number; cacheCreation: number; cacheRead: number },
): string {
  // Lookup tolerates the bare id and the provider/id form. Defaults to
  // Sonnet rate when unknown — prevents silent under-reporting if a new
  // model ships before this table is updated.
  const price =
    MODEL_PRICES[modelId] ??
    MODEL_PRICES[modelId.replace(/^anthropic\//, "")] ??
    MODEL_PRICES["anthropic/claude-sonnet-4-6"]!;

  // Anthropic pricing rules:
  //   non-cached input    → 1.0× input rate
  //   cache write (1h ttl)→ 2.0× input rate (we use ttl=1h in this client)
  //   cache read          → 0.1× input rate
  //   output              → 1.0× output rate
  const cost =
    (tokens.input / 1_000_000) * price.in +
    (tokens.cacheCreation / 1_000_000) * price.in * 2.0 +
    (tokens.cacheRead / 1_000_000) * price.in * 0.1 +
    (tokens.output / 1_000_000) * price.out;
  return cost.toFixed(6);
}
