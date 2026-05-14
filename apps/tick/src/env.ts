// Worker bindings exposed via c.env in Hono.
// Week 1: facilitator URL + D1 wired. DOs, AI Gateway, sandboxes come in week 2.

export type Bindings = {
  /** URL of the Faremeter facilitator (sibling CF Container app). */
  FACILITATOR_URL: string;

  /** Coinbase CDP fallback facilitator URL (failover for x402 if Faremeter is down). */
  CDP_FALLBACK_URL?: string;

  /**
   * frames-cloud base URL for read-mirror access to customer frames.
   * Defaults to `https://frames-cloud.workers.dev`; override for local dev
   * (e.g. `http://localhost:8787`) or alternate deployments.
   */
  FRAMES_CLOUD_BASE?: string;

  /**
   * Tool catalog base URL. Defaults to `https://catalog.frames.ag`.
   * Override to point at a customer-private catalog fork (per PLAN.md §10
   * decision #4) or a local dev catalog.
   */
  CATALOG_BASE?: string;

  /** D1 receipts store (runs, tool_calls, events). See migrations/0001_initial.sql. */
  DB: D1Database;

  /**
   * Service binding to the sibling `frames-cloud` Worker. When present, the
   * FrameClient routes through `env.FRAMES_CLOUD.fetch(...)` instead of the
   * public `*.workers.dev` URL. Required for Worker→Worker calls because
   * Cloudflare returns 404+1042 on direct workers.dev → workers.dev fetches.
   * Falls back to `FRAMES_CLOUD_BASE` when this binding is missing (local dev).
   */
  FRAMES_CLOUD?: Fetcher;

  /**
   * Service binding for the catalog Worker — same Worker→Worker pattern as
   * FRAMES_CLOUD. When `CATALOG_BASE` points at a `*.workers.dev` URL,
   * direct HTTP fetch returns 404+1042. The binding routes through CF's
   * internal RPC instead. Falls back to global fetch against `CATALOG_BASE`
   * when this binding is missing (local dev or external catalog).
   */
  CATALOG?: Fetcher;

  /**
   * Durable Object namespace for EntityAgent — runs each refresh_entity
   * sub-loop in an isolated DO instance. Concurrent across entities via
   * `Promise.all`, each with its own 30s CPU budget. Falls back to the
   * direct function call when this binding is missing (local Bun dev).
   *
   * Phase C of the cost-architecture redesign.
   */
  ENTITY_AGENT?: DurableObjectNamespace<import("./agents/entity-agent").EntityAgent>;

  /**
   * Workers AI binding. Hosts CF's own catalog (`@cf/...`) AND routes to
   * partnered third-party models with CF billing — including
   * `anthropic/claude-sonnet-4-6`, `openai/gpt-5-flash`, etc. The Worker
   * pays CF directly for tokens; no external provider account needed.
   *
   * Usage from LlmClient:
   *   await env.AI.run(model, body, { gateway: { id: AI_GATEWAY_SLUG } })
   *
   * Only available inside a deployed CF Worker — local Bun dev falls back
   * to the HTTP paths (anthropic API or Workers AI REST API).
   */
  AI?: Ai;
  /**
   * Slug of the AI Gateway to route Workers AI calls through (for logging
   * + cost dashboard). Optional — if unset, env.AI.run() bypasses the
   * gateway and CF tracks usage at the account level only.
   */
  AI_GATEWAY_SLUG?: string;

  // ---------------------------------------------------------------------
  // Outbound wallet secrets (set via `wrangler secret put`)
  //
  // Self-custody: tick signs every outbound paid call directly with these
  // keys. The EVM key serves both Base x402 and Tempo MPP (same private
  // key, two chains funded independently with USDC). See PLAN.md §6.
  // ---------------------------------------------------------------------
  /** 64-byte JSON array (`[1,2,...,3]`). Signs Solana x402 + Solana MPP charge. */
  SOLANA_OUTBOUND_KEYPAIR_JSON?: string;
  /** `0x`-hex secp256k1 private key. Signs Base x402 (EIP-3009) AND Tempo MPP charge. */
  EVM_OUTBOUND_PRIVATE_KEY?: string;
  /** Solana RPC URL (mainnet-beta or private node). */
  SOLANA_RPC_URL?: string;

  /**
   * Cloudflare AI Gateway base URL — routes LLM calls so we can switch models
   * (and providers later) without changing the client. Format:
   *
   *   https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>
   *
   * When unset, calls fall back to direct provider URLs (useful for dev).
   */
  AI_GATEWAY_URL?: string;
  /** Optional Bearer token for an authenticated AI Gateway. */
  AI_GATEWAY_TOKEN?: string;
  /**
   * **BYOK alias** — the Stripe-style mode. AI Gateway holds the provider keys
   * (Anthropic, OpenAI, Gemini) under named aliases set in the CF dashboard.
   * The Worker only references the alias; raw provider keys never leave the
   * gateway. Set this and you don't need ANTHROPIC_API_KEY in Worker secrets.
   *
   * Aliases are provider-scoped at the gateway: the same alias name routes to
   * the Anthropic key when the request hits /anthropic/*, the OpenAI key on
   * /openai/*, etc. One alias name covers all our providers.
   */
  AI_GATEWAY_BYOK_ALIAS?: string;
  /**
   * Anthropic API key — only needed for passthrough mode (dev/local without
   * a provisioned BYOK alias). Ignored when AI_GATEWAY_BYOK_ALIAS is set.
   */
  ANTHROPIC_API_KEY?: string;
  /** Direct Anthropic base URL fallback when AI_GATEWAY_URL is unset. */
  ANTHROPIC_BASE_URL?: string;

  /**
   * Ed25519 audit signing key (32-byte seed, hex or base64url). Signs every
   * ToolInvokedReceipt so offline verifiers can confirm the receipt came
   * from tick. When unset, receipts carry `signature: ""` and /health reports
   * `audit_key_configured: false`.
   */
  AUDIT_PRIVATE_KEY?: string;

  // ---------------------------------------------------------------------
  // Workers AI mode — Cloudflare-hosted models, CF bills directly.
  // No external provider account needed. Use this when you'd rather pay
  // Cloudflare for tokens than wire BYOK or passthrough to Anthropic.
  // ---------------------------------------------------------------------
  /** CF account ID for Workers AI. Required for Workers AI mode. */
  CF_ACCOUNT_ID?: string;
  /** API token with Workers AI:Run scope. Same scope as gateway tokens usually. */
  WORKERS_AI_TOKEN?: string;
  /**
   * Default Workers AI model. Must start with `@cf/`. Example:
   *   `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (recommended for agent loops)
   *   `@cf/qwen/qwq-32b`
   *   `@cf/google/gemma-3-12b-it`
   * When set, all `LlmClient.call()` invocations use this regardless of
   * the per-agent buildModel/titleModel defaults.
   */
  WORKERS_AI_MODEL?: string;

  /**
   * Per-sub-agent model override. When set, `refresh_entity` and
   * `discover_entity` sub-loops use this model instead of the parent's
   * `build` default. Sub-agents do bounded, focused reasoning — typically
   * fine on a cheaper tier (Haiku, or even Workers-AI hosted Llama/GLM).
   *
   * Format: `<provider>/<model-id>`. Examples:
   *   `anthropic/claude-haiku-4-5`              — default, 3× cheaper than Sonnet 4.6
   *   `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — Workers AI hosted, ~10× cheaper, function calling
   *   `@cf/openai/gpt-oss-20b`                   — OpenAI open-weight via Workers AI
   *   `@cf/zai-org/glm-4.7-flash`                — GLM Flash
   *
   * Unset → defaults to `anthropic/claude-haiku-4-5`. Parent stays on
   * its own `buildModel` for cross-entity reasoning.
   */
  SUB_AGENT_MODEL?: string;

  // ---------------------------------------------------------------------
  // x402 v2 PaymentRequirements config — only needed when adding inbound
  // billing in Phase B. Until `TICK_PAY_TO_ADDRESS` is set, the server
  // can't quote prices, so it never emits 402 challenges (verify falls back
  // to optional mode).
  // ---------------------------------------------------------------------
  /** Operator's receiving wallet. EVM hex (`0x…`) or Solana base58. */
  TICK_PAY_TO_ADDRESS?: string;
  /** Network slug. Defaults to `base`. Common: `base`, `solana-mainnet`, `tempo`. */
  TICK_PAY_NETWORK?: string;
  /** Token contract address. Defaults to USDC on Base. Override for other assets/chains. */
  TICK_PAY_ASSET?: string;
  /** Override the inferred payment scheme (e.g. `exact`, `erc3009`, `spl-token`). */
  TICK_PAY_SCHEME?: string;
  /** Max seconds the server waits for the client to settle (default 90). */
  TICK_PAY_MAX_TIMEOUT_SECONDS?: string;

  /**
   * Bearer-token API keys for closed-alpha customers. Comma-separated entries
   * of `<key>:<agent-identifier>`. Customer sends `Authorization: Bearer <key>`
   * (or `X-Tick-API-Key: <key>`); server maps to the agent identifier and
   * uses that as the stable identity for rate-limit + receipts.
   *
   * Example: `TICK_API_KEYS=k_alpha1:frames-runtime:0xCustomerA,k_alpha2:frames-runtime:0xCustomerB`
   *
   * When a Bearer header is present but doesn't match any configured key,
   * the request 401s — does NOT fall through to IP-hash identity. This
   * prevents an attacker from sending a junk key and silently getting
   * IP-hash auth.
   *
   * Replaced by x402-verify identity in Phase B (verified payer becomes the
   * stable agent automatically; no shared secrets needed).
   */
  TICK_API_KEYS?: string;

  /**
   * Comma-separated allowlist of agent identifiers permitted to hit `/run`.
   * Each entry matches `agent` exactly OR with a `*` suffix as a prefix glob.
   *
   * Three semantics depending on what's in the list:
   *   - `ip:<sha1prefix>`              — closed alpha, IP-derived identity
   *   - `ip:*`                         — wildcard for all IP-identified callers
   *   - `frames-runtime:<address>`     — verified-wallet auth (post-x402 or post-SIWX)
   *   - `*`                            — open mode; equivalent to no allowlist
   *
   * **Default when unset: closed.** The hosted endpoint refuses every `/run`
   * call until an operator explicitly opts in. CLI usage is unaffected
   * (the allowlist only gates HTTP requests).
   *
   * Example: `TICK_ALLOWED_AGENTS=frames-runtime:0xabc...,frames-runtime:0xdef...,ip:7f1a*`
   */
  TICK_ALLOWED_AGENTS?: string;

  // ---------------------------------------------------------------------
  // Wired in week 3+:
  // ---------------------------------------------------------------------
  // RUN_SESSION: DurableObjectNamespace;  // per-run agent state
  // WALLET: DurableObjectNamespace;       // global wallet DO (v1)
  // SANDBOX: DurableObjectNamespace;      // Cloudflare Sandboxes binding
  // R2_ARTIFACTS: R2Bucket;               // generated outputs
};
