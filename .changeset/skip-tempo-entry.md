---
"@frames-ag/tick": patch
---

fix: skip the Tempo wallet entry to keep Solana MPP + EVM x402 usable on Workers

Previous attempt to fix Tempo's dynamic-import failure (`fix(tick): static-import @frames-ag/payment-tempo so wrangler bundles it`, commit `0cea50cbc`) didn't actually work: wrangler does bundle the module's code when you static-reference it, but `@frames-ag/pay`'s `loadTempoMppHandler` uses `await import(pkg)` with a string variable — Workers' runtime has no module resolver to satisfy that lookup even when the code is in the bundle. The dynamic import throws "not installed", pay's catch translates that as a misleading error, and `createPaidFetch` aborts the whole call. Aborting takes Solana MPP and EVM x402 down with it, blocking ALL paid descriptors — not just Tempo ones.

This patch: skip registering the Tempo entry in `byNetwork` so `createPaidFetch` never reaches `loadTempoMppHandler`. The remaining handlers (Solana x402, Solana MPP charge, Base x402) all register and `paidFetch` becomes usable.

Cost of this fix: paid descriptors that REQUIRE Tempo MPP are unreachable. Acceptable for now — our $9 Tempo balance can be bridged to Base/Solana via agentcash when needed. Restore once `createPaidFetch` accepts injected handlers (then tick builds the Tempo handler itself via a static import).
