---
"@frames-ag/pay": patch
---

fix: drop `.ts` extensions from `@frames-ag/pay/wallet` re-exports

Pre-existing latent bug. `packages/pay/src/wallet/index.ts` re-exported from `./wallet-registry.ts` and `./paid-fetch.ts` with explicit `.ts` extensions. Worked at runtime (Bun resolves), but downstream consumers with `allowImportingTsExtensions: false` (which is the recommended setting when `noEmit: false`) failed during declaration emit:

```
error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
```

Triggered today when `@frames-ag/tick@0.5.x` extended its public surface (`CurateOptions.walletCapability`) so the declaration emit started traversing pay's wallet types. Drop the `.ts` extensions to match standard TS conventions and unblock consumers' declaration builds.

No behavior change. Same module, same exports.
