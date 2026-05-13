---
"@frames-ag/tick": patch
---

prompt: bias the curate agent toward `catalog_search` FIRST, web_fetch as fallback only

Last three live runs on layoffs-2026 / mcp-servers all settled at $0 because the agent reached for `web_fetch` directly for every lookup and never picked a paid catalog descriptor. The prompt mentioned `catalog_search` but framed it as a sub-option of "read/search tools" — agents read that as "use whichever is convenient."

Now the prompt has an explicit external-lookup contract:

> For ANY external lookup, the order is fixed:
> 1. `catalog_search(capability)` — ALWAYS first
> 2. `catalog_get(id)` — when you need full param schema
> 3. `tool_invoke(id, args)` — invoke the top match (runtime handles x402 / MPP automatically)
> 4. `web_fetch(url)` — FALLBACK ONLY, used when catalog yields zero hits or all probes fail

`web_fetch` is no longer listed under "external fetch (paid)" — it's framed as the fallback path. Catalog tools are framed as the default. This is the change that makes paid descriptors actually get tried so we can validate the `tool.invoked` / paid-settle path end-to-end.

Pure prompt-text change — no API surface affected.
