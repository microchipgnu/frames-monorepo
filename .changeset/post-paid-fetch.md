---
"@frames-ag/tick": patch
---

fix: route POST tool_invoke through paidFetch so MPP/x402 402 challenges get paid

The v0.4.4 probe loop on layoffs-2026 produced this telling signal: agent picked `mpp.brave.post.brave-news-search`, hit status=400 (`q is required`), self-corrected to use `q`, then hit status=402 with a Locus MPP challenge. The 402 should have been paid by the booted Solana wallet — but the POST branch of `dispatchToolInvoke` was using bare `fetch`, not `paidFetch`. The TODO was right there in the file. The 402 leaked as a probe event instead of being satisfied.

Fix: thread `paidFetch` from `bootWallets` → `pickWalletStack` (renamed from `pickRefetcher`) → `curate/discover` opts → `CatalogDispatchContext` → POST branch. GET branch already routed through `paidFetch` via `createPaidRefetcher`, so this only had to be wired for non-GET.

Falls back to global fetch when wallets aren't booted (local dev / no secrets) — 402s leak as probe events in that mode, matching prior behavior.

Once deployed, MPP POST descriptors should produce `tool.invoked` receipts with non-zero `settled` cost, not `catalog.probe` 402 events.
