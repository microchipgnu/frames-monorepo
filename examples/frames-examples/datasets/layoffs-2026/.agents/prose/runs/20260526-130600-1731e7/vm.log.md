# run:20260526-130600-1731e7 layoffs-curate-lite

upstream: [20260526-124729-7f9757]
root: src/curate.prose.md (writer + enricher + auditor only — discover phase replaced by upstream run; see forme.manifest.json `derivation` for subset rationale, backfilled post-execution)

1→ [input] frame ✓
2→ [input] upstream_discover_run ✓ (20260526-124729-7f9757)
3→ [input] new_candidates ✓ (14 rows, promoted from upstream shortfall)
4→ [input] min_field_coverage ✓ (0.6)
5→ writer ✓ (14 entities created / 124 facts set / 0 schema violations / 0 collisions)
6→ enricher ✓ (7/14 enriched / 12 facts / 6 SEC 8-K hits / 1 official statement verified / 0 WARN / 0 blocked)
7→ auditor ✓ (136 audited / 2 deprecated / 2 disputed / 6 under-covered / rejection_rate=1.47% (no overload))
---end 2026-05-26T13:25:00Z
