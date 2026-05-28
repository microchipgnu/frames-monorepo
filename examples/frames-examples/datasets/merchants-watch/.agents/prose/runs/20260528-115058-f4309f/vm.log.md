# run:20260528-115058-f4309f merchants-watch-curate

root: src/curate.prose.md

0→ [preflight] frame-mcp SELECT 1 ✓
0→ [preflight] wallet configured base+solana, USDC=? (proceed, budget-capped) ⚠
1→ [input] frame ✓
1→ [input] budget_usd ✓
1→ [input] naming_cap ✓
1→ [input] category_cap ✓
1→ [input] recognition_cap ✓
1→ [input] discovery_cap ✓
1→ [input] recognition_volume_floor_usd ✓
2→ inventory ✓ (naming=30 category=30 recognition=14 existing=1112)
3→ ∥start namer,categorizer,recognizer,discoverer
3a→ namer ✓ (22 proposed, 8 skipped, ~$0.04)
3b→ categorizer ✓ (28 categorized, 2 omitted, ~$0.01)
3c→ recognizer ✓ (12 confirmed, 2 infra-misclassified, ~$0.01)
3d→ discoverer ✓ (1 candidate revettr.com, ~$0.04)
3→ ∥done (≈$0.10 of $0.75 spent)
4→ writer ✓ (added=1 named=21 categorized=27 recognized=12 skipped=4; 141 facts)
5→ auditor ✓ (deprecated=9/141, off_host_required×9, success_rate=0.936, continue)
---end 2026-05-28T13:05:00Z
