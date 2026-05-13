---
"@frames-ag/tick": patch
---

fix: static-import @frames-ag/payment-tempo so wrangler bundles it

After the ArkType jitless fix landed, `bootWallets` revealed the next layer: `createPaidFetch: Tempo wallet registered but @frames-ag/payment-tempo is not installed`. The package IS installed as a dep; the issue is bundling. `@frames-ag/pay`'s `loadTempoMppHandler` does `import(pkg)` with a runtime-variable specifier (a deliberate trick to keep arktype's type-checker happy). Wrangler/esbuild can't statically analyze that, so the module never reaches the deployed Worker bundle; the runtime import then fails and pay's catch handler reports "not installed".

Fix: side-effect static import in `src/wallet.ts`. Wrangler sees the static reference, ships the module; pay's runtime dynamic import resolves cleanly.

After deploy, `/health.wallets.paid_fetch.mppHandlerCount` should be >= 2 (Solana MPP charge + Tempo MPP charge), `handlerCount` >= 2 (x402 EVM + x402 Solana).
