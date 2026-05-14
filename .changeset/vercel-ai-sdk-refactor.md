---
"@frames-ag/tick": minor
---

LlmClient internals → Vercel AI SDK + ai-gateway-provider (693 → 330 LOC)

Public API unchanged — every call site continues `await llm.call({system, messages, tools, agent})`. What changed is the implementation underneath: hand-rolled Anthropic Messages API + Workers AI HTTP + provider-routing (~500 lines of plumbing) is replaced with `generateText()` from the `ai` package, routed through `ai-gateway-provider`.

### Why

Every additional provider required ~300 lines (auth, request shape, response shape, tool-call translation). Adding `openai/*`, `google/*`, `xai/*`, etc. for sub-agent cost optimization would have been a real engineering project. With `ai-gateway-provider`, any model becomes a string: `SUB_AGENT_MODEL=openai/gpt-5.4-nano` or `SUB_AGENT_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast` or `SUB_AGENT_MODEL=google/gemini-3.1-flash-lite`. The gateway resolves auth via BYOK aliases stored on the CF dashboard.

### What's preserved (no call-site changes)

- All public types: `LlmRole`, `LlmContent`, `LlmMessage`, `LlmToolSpec`, `LlmUsage`, `LlmResponse`, `CallOptions`, `LlmClientConfig`, `LlmError`.
- The `LlmClient.call(opts)` shape — same input, same output.
- Per-agent default models (`buildModel`, `titleModel`, `exploreModel`).
- `SUB_AGENT_MODEL` env var (lands separately, this PR makes the override trivial).

### What's gone

- The hand-rolled Anthropic Messages API request/response code.
- The Workers AI HTTP fallback path (Workers AI is now reachable via `workers-ai/@cf/...` model strings through the gateway).
- The per-provider model price table — CF AI Gateway is the authoritative billing source; we no longer compute `estimated_cost` from token counts. Diagnostic field set to "0"; usage tokens still propagated for telemetry.
- The `retry` wrapper — Vercel SDK handles transient errors via its own retry strategy.

### New deps

- `ai@6.0.182` — the core SDK
- `ai-gateway-provider@3.1.3` — CF AI Gateway routing
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/xai`, `@ai-sdk/groq` — provider adapters (only the ones we'll actually use load at runtime)

### Migration / message-format translation

The trickiest part: our `LlmContent` shape (Anthropic-style: `text | tool_use | tool_result` blocks all in a single message) → Vercel SDK's `ModelMessage[]` (which separates tool results into their own `role: "tool"` messages). A `user` message containing both `tool_result` and `text` blocks splits into two SDK messages (one `role: "tool"` + one `role: "user"`).

Tools are mapped via the SDK's `tool({description, inputSchema})` factory. We deliberately don't pass `execute` — sub-agents dispatch tools externally (catalog_search, web_fetch, etc.), so the SDK returns `tool_calls` for our code to handle and we feed results back as the next user message.

Response mapping: `result.text + result.toolCalls` → our `content[]` array; `finishReason` ("stop"|"tool-calls"|"length") → our `stop_reason` ("end_turn"|"tool_use"|"max_tokens").

### Tests

169/169 pass. No test changes needed because the public LlmClient surface didn't change.

### Next steps (separate ship)

Once this is in prod and a tick-hosted run validates end-to-end, sub-agents can flip to a cheaper model via `SUB_AGENT_MODEL`. Realistic candidates:

- `anthropic/claude-haiku-4-5` — 3× cheaper than Sonnet 4.6, same Anthropic tool-use shape
- `openai/gpt-5.4-nano` — fast + cheap, OpenAI tool calling
- `google/gemini-3.1-flash-lite` — Google's cheapest with function calling
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — 10× cheaper than Sonnet, function calling, hosted on Workers AI

Each is a single env-var change with no code touched.
