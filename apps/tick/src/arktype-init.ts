// Disable ArkType's runtime code-generation (`new Function`/eval) so the
// faremeter packages — which depend on ArkType 2.x for input validation —
// can construct their schemas inside Cloudflare Workers.
//
// Workers' V8 isolate refuses `Code generation from strings disallowed for
// this context`, which is what ArkType's default precompile path triggers.
// Setting `jitless: true` switches to the interpreted validation path.
// Slower per-check, but works in CSP-locked contexts.
//
// This file MUST be imported before any module that transitively pulls in
// @faremeter/*, otherwise those packages' top-level schema construction
// has already evaluated against the JIT path. Practical rule: import it
// as the very first statement in the Worker entry (`worker.ts`) and in the
// Bun dev entry (`index.ts`).

import { configure } from "arktype/config";

configure({ jitless: true });
