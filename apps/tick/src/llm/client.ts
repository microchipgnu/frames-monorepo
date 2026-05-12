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
}

// Per-token prices (USDC per 1M tokens) for cost estimation.
// Source: PLAN.md §4 — frame pricing research, May 2026.
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "anthropic/claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "anthropic/claude-opus-4-7": { in: 5.0, out: 25.0 },
  // Aliases without provider prefix (back-compat with raw model ids):
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-7": { in: 5.0, out: 25.0 },
};

export class LlmClient {
  private cfg: LlmClientConfig;

  constructor(cfg: LlmClientConfig) {
    this.cfg = {
      buildModel: "anthropic/claude-sonnet-4-6",
      titleModel: "anthropic/claude-haiku-4-5",
      exploreModel: "anthropic/claude-sonnet-4-6",
      anthropicBaseUrl: "https://api.anthropic.com",
      ...cfg,
    };
  }

  async call(opts: CallOptions): Promise<LlmResponse> {
    const model = opts.model ?? this.pickModel(opts.agent ?? "build");
    const { provider, modelId } = splitModelId(model);

    if (provider !== "anthropic") {
      throw new LlmError(
        `Provider "${provider}" is not implemented yet. Supported: anthropic. Coming: openai, google-ai-studio.`,
      );
    }

    return await this.callAnthropic(modelId, model, opts);
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
    if (agent === "title") return this.cfg.titleModel!;
    if (agent === "explore") return this.cfg.exploreModel!;
    return this.cfg.buildModel!;
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
