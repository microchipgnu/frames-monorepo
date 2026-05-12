// LLM client for the curate op.
//
// Routes through Cloudflare AI Gateway by default. The gateway URL pattern is:
//
//   https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>
//
// AI Gateway accepts requests at provider-specific subpaths and forwards them
// upstream after applying caching, rate limiting, BYOK key injection, and
// per-request cost attribution. Switching models is just changing the model
// string — no client rewrite needed.
//
//   /anthropic/v1/messages          → Anthropic Messages API shape
//   /openai/chat/completions        → OpenAI Chat Completions shape  (TODO)
//   /google-ai-studio/.../generateContent → Gemini shape             (TODO)
//
// This client currently speaks the Anthropic Messages API only. Adding OpenAI
// + Gemini requires shape normalization on both request and response sides;
// they're tracked as follow-up. Model strings are prefixed (`anthropic/...`,
// `openai/...`, `google/...`) so the dispatcher picks the right path.
//
// When AI_GATEWAY_URL is unset the client falls back to calling Anthropic
// direct (`https://api.anthropic.com`), useful for local dev without a
// gateway provisioned.

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
  /** USDC, computed by the client from the model's published per-token price. */
  estimated_cost: string;
}

export interface LlmResponse {
  /** "tool_use" if the model wants to call a tool, "end_turn" if done, "max_tokens" / "stop_sequence" otherwise. */
  stop_reason: string;
  /** Content blocks emitted by the model, in order. May include text + tool_use. */
  content: LlmContent[];
  usage: LlmUsage;
}

export interface CallOptions {
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  max_tokens?: number;
  /** Subagent role hint — affects model selection. Default "build". */
  agent?: "title" | "build" | "explore";
  /**
   * Explicit model override. Format: `<provider>/<model-id>` e.g.
   * `anthropic/claude-sonnet-4-6`. When set, overrides the agent-based pick.
   */
  model?: string;
}

export interface LlmClientConfig {
  /**
   * Cloudflare AI Gateway base URL — `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`.
   * When set, all calls route through the gateway. When unset, falls back to
   * calling each provider's API directly (dev/local mode).
   */
  gatewayUrl?: string;
  /** Optional Bearer token for an authenticated AI Gateway (`cf-aig-authorization`). */
  gatewayToken?: string;
  /**
   * **BYOK mode** (recommended): the AI Gateway holds the provider API keys
   * under named aliases (set in the CF dashboard). The Worker only knows the
   * alias name — never the raw provider key. Gateway injects the real key
   * upstream based on the request's URL path (provider) + this alias.
   *
   * Set this and you don't need `anthropicApiKey` (or future openaiApiKey/etc).
   * Think of it like Stripe: gateway owns the secrets, app references them.
   *
   * Unset → passthrough mode (your app supplies the provider key directly,
   * useful for local dev without provisioning gateway BYOK).
   */
  byokAlias?: string;
  /** Passthrough-mode Anthropic key. Used only when byokAlias is unset. */
  anthropicApiKey?: string;
  /** Direct base URL when gatewayUrl is unset. Default `https://api.anthropic.com`. */
  anthropicBaseUrl?: string;
  /** Per-agent model defaults. All prefixed `<provider>/<model-id>`. */
  buildModel?: string;
  titleModel?: string;
  exploreModel?: string;
  /** Optional metadata attached to gateway requests for attribution + cost tracking. */
  gatewayMetadata?: Record<string, string>;

  // ---------------------------------------------------------------------
  // Workers AI mode — Cloudflare-hosted models, CF bills directly.
  // When `workersAiAccountId` is set AND no provider key is configured,
  // the client routes to `api.cloudflare.com/.../ai/v1/chat/completions`
  // (OpenAI-compat shape) and translates to/from the Anthropic-style
  // LlmResponse our ops expect.
  // ---------------------------------------------------------------------
  /** CF account ID. Required for Workers AI mode. */
  workersAiAccountId?: string;
  /** API token with Workers AI:Run scope. */
  workersAiToken?: string;
  /** Default model when workersAi mode is on. e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. */
  workersAiModel?: string;

  /**
   * Cloudflare Workers AI binding. When present, `anthropic/*` and `@cf/*`
   * models go through `env.AI.run()` and Cloudflare bills directly — no
   * Anthropic / OpenAI account needed. Strictly preferred over HTTP-mode
   * Workers AI when available (it runs inside the CF edge with no network
   * hop). Local dev (Bun) doesn't get this binding; it falls back to HTTP.
   */
  ai?: Ai;
  /**
   * Slug of the AI Gateway to route env.AI.run() calls through (for logging).
   * When set, every AI binding call gets `{ gateway: { id } }`.
   */
  aiGatewaySlug?: string;
}

// Per-token prices (USDC per 1M tokens) for cost estimation.
// Source: PLAN.md §4 — frame pricing research, May 2026.
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-haiku-4.5": { in: 1.0, out: 5.0 },
  "anthropic/claude-sonnet-4.6": { in: 3.0, out: 15.0 },
  "anthropic/claude-opus-4.7": { in: 5.0, out: 25.0 },
  // Dash-form aliases (legacy convention; some CF/Anthropic surfaces use these).
  "anthropic/claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "anthropic/claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "anthropic/claude-opus-4-7": { in: 5.0, out: 25.0 },
  // Aliases without provider prefix (back-compat with raw model ids):
  "claude-haiku-4.5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4.6": { in: 3.0, out: 15.0 },
  "claude-opus-4.7": { in: 5.0, out: 25.0 },
  // Workers AI — Cloudflare's hosted models. Prices in USDC per 1M tokens
  // per https://developers.cloudflare.com/workers-ai/platform/pricing/
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "@cf/meta/llama-3.1-70b-instruct": { in: 0.293, out: 2.253 },
  "@cf/meta/llama-3.1-8b-instruct": { in: 0.282, out: 0.827 },
  "@cf/qwen/qwq-32b": { in: 0.66, out: 1.0 },
  "@cf/google/gemma-3-12b-it": { in: 0.345, out: 0.556 },
};

export class LlmClient {
  private cfg: LlmClientConfig;

  constructor(cfg: LlmClientConfig) {
    this.cfg = {
      buildModel: "anthropic/claude-sonnet-4.6",
      titleModel: "anthropic/claude-haiku-4.5",
      exploreModel: "anthropic/claude-sonnet-4.6",
      anthropicBaseUrl: "https://api.anthropic.com",
      ...cfg,
    };
  }

  async call(opts: CallOptions): Promise<LlmResponse> {
    const model = opts.model ?? this.pickModel(opts.agent ?? "build");

    // Preferred path inside a CF Worker: env.AI.run() binding. Routes both
    // CF-hosted (@cf/*) and partnered third-party (anthropic/*, openai/*)
    // models with CF billing. No external HTTP, no provider account needed.
    if (this.cfg.ai && (model.startsWith("@cf/") || model.startsWith("anthropic/"))) {
      return await this.callAiBinding(model, opts);
    }

    // Workers AI via HTTP (used when running outside a Worker, e.g. Bun dev).
    if (model.startsWith("@cf/")) {
      if (!this.cfg.workersAiAccountId || !this.cfg.workersAiToken) {
        throw new LlmError(
          `workersAiAccountId + workersAiToken required for ${model}. Set CF_ACCOUNT_ID + WORKERS_AI_TOKEN on the Worker.`,
        );
      }
      return await this.callWorkersAi(model, opts);
    }

    const { provider, modelId } = splitModelId(model);
    if (provider !== "anthropic") {
      throw new LlmError(
        `Provider "${provider}" is not implemented yet. Supported: anthropic, @cf/* (Workers AI).`,
      );
    }
    return await this.callAnthropic(modelId, model, opts);
  }

  // -----------------------------------------------------------------------
  // CF Workers AI binding — preferred when running inside a Worker.
  // Handles both @cf/* (CF-hosted) and anthropic/* (partnered third-party
  // with CF billing) models. The binding speaks each provider's native shape
  // (Anthropic Messages API for anthropic/*, OpenAI-compat for @cf/*).
  // -----------------------------------------------------------------------

  private async callAiBinding(model: string, opts: CallOptions): Promise<LlmResponse> {
    const gatewayOpts = this.cfg.aiGatewaySlug ? { gateway: { id: this.cfg.aiGatewaySlug } } : undefined;

    if (model.startsWith("anthropic/")) {
      // Anthropic models speak the Messages API natively through the binding.
      // We can pass the exact body shape our callAnthropic() builds.
      const body: Record<string, unknown> = {
        max_tokens: opts.max_tokens ?? 4096,
        system: opts.system,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (opts.tools && opts.tools.length > 0) {
        body.tools = opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        }));
      }
      const json = await this.cfg.ai!.run(model, body as never, gatewayOpts);
      const j = json as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
        usage: { input_tokens: number; output_tokens: number };
      };
      // Diagnostic: log the raw content shape on first response so we can see
      // exactly what the CF binding sends back. Anthropic via marketplace
      // may rename or omit fields — `tool_use.id` is required downstream
      // because the next iter echoes the block back to the model.
      console.log("[ai-binding-anthropic] raw content:", JSON.stringify(j.content).slice(0, 800));
      // Normalize: ensure every tool_use block has an `id`. CF's binding
      // sometimes returns these without ids, which breaks Anthropic on the
      // next iter when we echo the assistant turn back into messages.
      const normalized = (j.content ?? []).map((block) => {
        if (block.type === "tool_use" && !block.id) {
          return { ...block, id: `tu_${Math.random().toString(36).slice(2, 14)}` };
        }
        return block;
      }) as LlmContent[];
      const price = PRICES[model] ?? PRICES[model.replace("anthropic/", "")] ?? { in: 3.0, out: 15.0 };
      const cost =
        (j.usage.input_tokens / 1_000_000) * price.in +
        (j.usage.output_tokens / 1_000_000) * price.out;
      return {
        stop_reason: j.stop_reason,
        content: normalized,
        usage: {
          input_tokens: j.usage.input_tokens,
          output_tokens: j.usage.output_tokens,
          estimated_cost: cost.toFixed(6),
        },
      };
    }

    // @cf/* models — OpenAI-compat shape through the binding (same shape as
    // the HTTP path in callWorkersAi). Translate Anthropic-style messages
    // and tool blocks, then translate the response back to Anthropic shape.
    const body: Record<string, unknown> = {
      messages: anthropicToOpenAiMessages(opts.system, opts.messages),
      max_tokens: opts.max_tokens ?? 4096,
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      body.tool_choice = "auto";
    }
    const json = (await this.cfg.ai!.run(model, body as never, gatewayOpts)) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = json.choices[0];
    if (!choice) throw new LlmError("env.AI.run returned empty choices");
    const content: LlmContent[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
    const stopReason = openAiFinishToAnthropicStop(choice.finish_reason);
    const price = PRICES[model] ?? { in: 0.5, out: 1.0 };
    const cost =
      (json.usage.prompt_tokens / 1_000_000) * price.in +
      (json.usage.completion_tokens / 1_000_000) * price.out;
    return {
      stop_reason: stopReason,
      content,
      usage: {
        input_tokens: json.usage.prompt_tokens,
        output_tokens: json.usage.completion_tokens,
        estimated_cost: cost.toFixed(6),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Anthropic Messages API
  // -----------------------------------------------------------------------

  private async callAnthropic(modelId: string, fullModelString: string, opts: CallOptions): Promise<LlmResponse> {
    const useByok = !!(this.cfg.gatewayUrl && this.cfg.byokAlias);
    if (!useByok && !this.cfg.anthropicApiKey) {
      throw new LlmError(
        "Either byokAlias (BYOK mode) or anthropicApiKey (passthrough mode) is required for anthropic/* models",
      );
    }

    const url = this.anthropicUrl();
    const body = {
      model: modelId,
      max_tokens: opts.max_tokens ?? 4096,
      system: opts.system,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(opts.tools && opts.tools.length > 0
        ? {
            tools: opts.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })),
          }
        : {}),
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (useByok) {
      // BYOK: gateway injects the real Anthropic key based on this alias.
      // Our Worker never sees the raw provider secret.
      headers["cf-aig-byok-alias"] = this.cfg.byokAlias!;
    } else {
      // Passthrough: app supplies the provider key directly.
      headers["x-api-key"] = this.cfg.anthropicApiKey!;
    }
    if (this.cfg.gatewayToken) headers["cf-aig-authorization"] = `Bearer ${this.cfg.gatewayToken}`;
    if (this.cfg.gatewayMetadata) headers["cf-aig-metadata"] = JSON.stringify(this.cfg.gatewayMetadata);

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`Anthropic ${res.status} (via ${this.cfg.gatewayUrl ? "AI Gateway" : "direct"}): ${text.slice(0, 500)}`, res.status);
    }

    const json = (await res.json()) as {
      stop_reason: string;
      content: LlmContent[];
      usage: { input_tokens: number; output_tokens: number };
    };

    const price = PRICES[fullModelString] ?? PRICES[modelId] ?? { in: 3.0, out: 15.0 };
    const cost =
      (json.usage.input_tokens / 1_000_000) * price.in +
      (json.usage.output_tokens / 1_000_000) * price.out;

    return {
      stop_reason: json.stop_reason,
      content: json.content,
      usage: {
        input_tokens: json.usage.input_tokens,
        output_tokens: json.usage.output_tokens,
        estimated_cost: cost.toFixed(6),
      },
    };
  }

  private anthropicUrl(): string {
    if (this.cfg.gatewayUrl) {
      // CF AI Gateway: /anthropic/v1/messages
      return `${this.cfg.gatewayUrl.replace(/\/$/, "")}/anthropic/v1/messages`;
    }
    return `${this.cfg.anthropicBaseUrl}/v1/messages`;
  }

  private pickModel(agent: "title" | "build" | "explore"): string {
    // AI binding present + no explicit WORKERS_AI_MODEL override → prefer
    // Anthropic flagship via CF's marketplace billing. Per-agent defaults
    // (buildModel etc.) already point at anthropic/* models, so we just
    // fall through to them.
    if (this.cfg.ai && !this.cfg.workersAiModel) {
      if (agent === "title") return this.cfg.titleModel!;
      if (agent === "explore") return this.cfg.exploreModel!;
      return this.cfg.buildModel!;
    }
    // WORKERS_AI_MODEL override forces Workers AI catalog (cheap fallback).
    if (this.cfg.workersAiModel) return this.cfg.workersAiModel;
    if (agent === "title") return this.cfg.titleModel!;
    if (agent === "explore") return this.cfg.exploreModel!;
    return this.cfg.buildModel!;
  }

  // -----------------------------------------------------------------------
  // Workers AI (OpenAI-compat over Cloudflare's catalog)
  // -----------------------------------------------------------------------

  private async callWorkersAi(model: string, opts: CallOptions): Promise<LlmResponse> {
    // Optionally route through the customer's AI Gateway for logging + cost
    // tracking. CF supports `gateway/workers-ai/v1/chat/completions` for this,
    // but it has to be explicitly enabled on the gateway. Fall back to the
    // account API endpoint, which always works.
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.cfg.workersAiAccountId}/ai/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.max_tokens ?? 4096,
      messages: anthropicToOpenAiMessages(opts.system, opts.messages),
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.cfg.workersAiToken}`,
    };

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`Workers AI ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
    const json = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = json.choices[0];
    if (!choice) throw new LlmError("Workers AI returned empty choices array");

    const content: LlmContent[] = [];
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    for (const tc of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // Some models return malformed JSON. Pass through as string under `_raw`
        // so the tool dispatcher can decide how to handle.
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }

    const stopReason = openAiFinishToAnthropicStop(choice.finish_reason);

    const price = PRICES[model] ?? { in: 0.5, out: 1.0 };
    const cost =
      (json.usage.prompt_tokens / 1_000_000) * price.in +
      (json.usage.completion_tokens / 1_000_000) * price.out;

    return {
      stop_reason: stopReason,
      content,
      usage: {
        input_tokens: json.usage.prompt_tokens,
        output_tokens: json.usage.completion_tokens,
        estimated_cost: cost.toFixed(6),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic ↔ OpenAI message-shape translators
// ---------------------------------------------------------------------------

/**
 * Convert our Anthropic-style messages (with tool_use / tool_result content
 * blocks) into OpenAI-compat chat completion messages.
 *
 * Rules:
 *   - `system` → leading `{ role: "system", content: "..." }`
 *   - assistant turn with `tool_use` block(s) → `{ role: "assistant",
 *     content: "<text>", tool_calls: [{ id, type:"function", function:{...} }] }`
 *   - user turn whose content is all `tool_result` blocks → one
 *     `{ role: "tool", tool_call_id, content }` per block
 *   - everything else: flatten text blocks to a single string
 */
function anthropicToOpenAiMessages(
  system: string,
  messages: LlmMessage[],
): Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }> {
  const out: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolUses = m.content.filter((c): c is Extract<LlmContent, { type: "tool_use" }> => c.type === "tool_use");
      const msg: { role: string; content: string; tool_calls?: unknown[] } = { role: "assistant", content: text };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        }));
      }
      out.push(msg);
      continue;
    }

    // user turn: may contain tool_result blocks (one or more) and/or text blocks.
    const toolResults = m.content.filter((c): c is Extract<LlmContent, { type: "tool_result" }> => c.type === "tool_result");
    if (toolResults.length > 0) {
      // OpenAI's chat-completion API requires one `{role:"tool",tool_call_id,content}` message per tool_result.
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
      }
      const textOnly = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (textOnly) out.push({ role: "user", content: textOnly });
      continue;
    }

    // Plain user turn
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    out.push({ role: "user", content: text });
  }

  return out;
}

/**
 * Map OpenAI's `finish_reason` to Anthropic's `stop_reason`.
 *
 *   stop          → end_turn       (model wrapped up cleanly)
 *   tool_calls    → tool_use       (model wants a tool call)
 *   length        → max_tokens     (cut off by max_tokens)
 *   content_filter → end_turn      (treat as cleanly stopped — content was filtered)
 *
 * Anything else flows through verbatim; the agent loop has a fallback branch
 * for unrecognized stop reasons.
 */
function openAiFinishToAnthropicStop(finish: string): string {
  switch (finish) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "end_turn";
    default:
      return finish;
  }
}

function splitModelId(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
  }
  // Bare model ids without prefix → assume anthropic (back-compat).
  return { provider: "anthropic", modelId: model };
}

export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "LlmError";
  }
}
