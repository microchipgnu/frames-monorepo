# run:20260526-145143-c7a3f2 merchants-watch-curate

root: src/curate.prose.md

1→ [input] frame ✓
2→ [input] budget_usd ✓
3→ [input] naming_cap ✓
4→ [input] category_cap ✓
5→ [input] recognition_cap ✓
6→ [input] discovery_cap ✓
7→ [input] recognition_volume_floor_usd ✓
8→ [preflight] mcp:pay configured (wallets: base + solana-mainnet, balance probe unresolved; operator approved proceed) ✓
9→ [preflight] mcp:frame-merchants-watch ✓
10→ [preflight] cli:curl ✓
11→ inventory ✓
12→ [outage] mcp:frame-merchants-watch unusable (better-sqlite3 NODE_MODULE_VERSION 147 vs 137); operator chose proposers-only path — writer + auditor deferred
13a→ namer ✓ (25/30 proposed, 0 paid escalations — pay catalog drift blocked exa_search/firecrawl_scrape)
13b→ categorizer ✓ (28/30 proposed via free signals — finance:10, search:6, data:4, media:3, others:5; 0 paid)
13c→ recognizer ✓ (9 confirmed, 10 unconfirmed, 1 infra-misclassified; 16 paid calls, spent=$0.16)
13d→ discoverer ✓ (3 candidates: app.suedeai.ai, agentworld.me, api.trustboost.dev; 3 paid searches, spent=$0.03)
13→ ∥done (proposers complete; run-total spent_usd=$0.19 of $0.75 cap)
14→ writer ⊘ deferred (mcp:frame-merchants-watch unusable this session)
15→ auditor ⊘ deferred (depends on writer)
---end 2026-05-26T16:11:00Z (partial: proposers-only; writer + auditor deferred — see bindings/auditor/report.json)
---resume 2026-05-26T17:00:00Z (better-sqlite3 rebuilt under Node 24 ABI 137; mcp:frame-merchants-watch confirmed healthy with SELECT 1)
14→ writer ✓ (reconstructed from facts: 160 facts on 60 entities; 32 named, 28 categorized, 9 recognized, 3 added, 18 skipped; original session socket-dropped mid-flight but writes had already landed)
15→ auditor ✓ (137 passed, 23 rejected = 14.4%; 23 deprecate_fact calls; histogram: source_404=2, value_not_in_source=4, paraphrased=13, infra_host=4; curate_success_rate=0.856)
---end 2026-05-26T17:30:00Z (resumed run complete; recommend_action=continue)
