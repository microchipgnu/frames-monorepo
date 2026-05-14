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

import { generateText, type ModelMessage, tool as aiTool } from "ai";
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

    // Two routing paths:
    //   1. Gateway path (production): all calls flow through CF AI Gateway,
    //      which resolves provider auth via stored BYOK aliases. Any model
    //      string (anthropic/*, openai/*, google/*, @cf/*) works.
    //   2. Direct Anthropic (local dev / smoketest): no gateway configured,
    //      but ANTHROPIC_API_KEY is present. Only anthropic/* models work.
    const gw = this.tryParseGateway();
    let model;
    if (gw) {
      const aigateway = createAiGateway({
        accountId: gw.accountId,
        gateway: gw.gatewaySlug,
        apiKey: this.cfg.gatewayToken,
      });
      // Only pass apiKey to createUnified when actually set. Passing
      // `{ apiKey: undefined }` confuses the provider vs. omitting entirely.
      const unified = this.cfg.byokAlias
        ? createUnified({ apiKey: this.cfg.byokAlias })
        : createUnified();
      model = aigateway(unified(modelId));
    } else if (this.cfg.anthropicApiKey && modelId.startsWith("anthropic/")) {
      // Direct passthrough for local dev. Strip the `anthropic/` prefix
      // because @ai-sdk/anthropic's createAnthropic() wants the bare model id.
      const anthropic = createAnthropic({ apiKey: this.cfg.anthropicApiKey });
      model = anthropic(modelId.replace(/^anthropic\//, ""));
    } else {
      throw new LlmError(
        `LlmClient unconfigured: no AI gateway (gatewayUrl / cfAccountId+aiGatewaySlug) and no anthropicApiKey for model ${modelId}.`,
      );
    }

    const messages = mapToModelMessages(opts.messages);
    const tools = mapToTools(opts.tools);

    let result;
    try {
      result = await generateText({
        model,
        system: opts.system,
        messages,
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
          path: gw ? "gateway" : "anthropic-passthrough",
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
    // The SDK accepts a JSON Schema directly via `inputSchema` (recent
    // versions). Older versions wanted a Zod schema; we use the JSON Schema
    // path since our LlmToolSpec already carries it.
    out[t.name] = aiTool({
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: t.input_schema as any,
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

  const usage: LlmUsage = {
    input_tokens: result.usage?.inputTokens ?? result.usage?.promptTokens ?? 0,
    output_tokens: result.usage?.outputTokens ?? result.usage?.completionTokens ?? 0,
    // Estimated cost: best-effort placeholder — CF AI Gateway is the
    // authoritative billing source. Diagnostic value only.
    estimated_cost: "0",
  };

  return {
    stop_reason,
    content,
    usage,
    model: result.response?.modelId ?? modelId,
  };
}
