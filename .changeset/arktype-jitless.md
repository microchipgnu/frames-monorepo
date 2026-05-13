---
"@frames-ag/tick": patch
---

fix: enable ArkType jitless mode so faremeter works on Cloudflare Workers

CRITICAL: paidFetch has never actually worked on the deployed tick Worker. Every `settled=$0` we've seen — including before today — was a silent fallback to bare fetch.

Root cause: `@faremeter/*` packages depend on ArkType 2.x for input validation. ArkType's default mode JIT-compiles validators via `new Function`/`eval`. Cloudflare Workers' V8 isolate disallows code generation from strings (`EvalError: Code generation from strings disallowed for this context`). `bootWallets` was throwing on every cold start with `Error: Encountered an unexpected error while compiling your definition: ... morph14Allows ... domain1Apply`, the catch handler logged a warning, and tick silently fell back to `createHttpRefetcher()` — which gives back a free, non-paying fetch.

Fix: new `src/arktype-init.ts` calls `configure({ jitless: true })` from `arktype/config`. Imported as the FIRST statement in both `worker.ts` (deployed entry) and `index.ts` (Bun dev entry). ArkType then uses interpreted validation instead of compiling, slower per-check but Workers-compatible.

After deploy, `/health.wallets.paid_fetch` should report non-zero `handlerCount` + `mppHandlerCount`. paidFetch becomes actually paid.

Found via:
1. New `tool_invoke_post_response` log + `bootWallets failed` warning surfaced through `wrangler tail`.
2. /health diagnostics returned `paid_fetch: null` (boot threw) confirming the wallet stack wasn't constructed.

Added `arktype: ^2.2.0` as a direct dep (was transitive) so the `arktype/config` subpath resolves at typecheck time.
