---
"@frames-ag/tick": minor
---

sub-agents (refresh_entity, discover_entity) get full catalog access

Today's runs showed the actual external-fetch work happens in sub-agents, not the parent curate loop. 19 of 19 sub-agents on mcp-servers went straight to `web_fetch`; 4 stalled with `no_progress` retrying GitHub URLs the auto-summarizer drops fields from. The parent-loop catalog-first prompt change had zero effect because sub-agents had their own narrow tool palette (`web_fetch`, `propose_facts`, `propose_deprecations`, `no_change`) — no `catalog_search`, no `tool_invoke`. And the EntityAgent DO used the FREE refetcher, so even if it had paid tools they wouldn't have settled.

This change wires the paid stack and catalog tools end-to-end into the sub-agent loops:

- **EntityAgent DO now boots the paid wallet stack** via the new shared `pickWalletStack` helper (moved from `app.ts` to `wallet.ts` so the DO can call it too). `arktype-init` is imported FIRST so faremeter's ArkType schemas compile cleanly inside the DO isolate.
- **EntityAgent DO constructs a CatalogClient** using the same service binding (`env.CATALOG`) the parent uses.
- **`refreshEntity()` and `discoverEntity()` accept** new optional fields: `catalog`, `paidFetch`, `walletCapability`, `env`. When present, the sub-agent gains `catalog_search`, `catalog_get`, and `tool_invoke` tools alongside its terminal proposals.
- **Sub-agent system prompts** now bias catalog-first when catalog is wired in. Explicit guidance: "FIRST: try `catalog_search(capability)` — paid descriptors return structured first-class JSON fields the summarizer doesn't drop. Only fall back to `web_fetch` when catalog yields zero hits."
- **`curate.ts` threads the paid stack** into both the inline-fallback `refreshEntity()` / `discoverEntity()` call paths.

Combined with the new `walletCapability` filter on `catalog_search` (this release), sub-agents now have everything they need to organically exercise the paid path:
- Bias toward catalog ✓
- Catalog tools available ✓
- paidFetch wired ✓
- Filtered to only payable descriptors ✓

Tests: 169/169 pass. `bun run build` clean (declaration emit needed the dependent `.ts` extension fix in `@frames-ag/pay`'s wallet subpath — landed in pay@^0.2.2).
