---
"@frames-ag/tick": patch
---

catalog_search filters descriptors by booted wallet capability

Today's brave-news-search probes showed the agent attempting tools the runtime can't pay (Locus MPP requires Solana — fine — but other Tempo MPP descriptors would also surface even though Tempo isn't booted on this Worker). Each unpayable descriptor wastes a `tool_invoke` iteration → 402 → `payment_unhandled` probe.

`dispatchCatalogSearch` now over-fetches (×3 the requested limit) and filters out descriptors whose `payment.protocol × payment.network` doesn't match a booted wallet. Filter logic in `descriptorRequiresWallet()`:

- `x402` on `base` / `solana` → needs `evm` / `solana` wallet
- `mpp` on `solana` / `tempo` / `base` → needs `solana` / `tempo` / `evm` wallet
- Unknown protocol/network combination → filtered (no handler shape)

When at least one descriptor is filtered, the result includes `filtered_unpayable` + `payable_chains` so the agent sees what's available. When `walletCapability` is undefined (local dev without env), the filter is permissive (all results shown).

`walletCapability` is threaded from `BootedWallets.diagnostics.configured` → `pickWalletStack` → `CurateOptions.walletCapability` → `CatalogDispatchContext.walletCapability`. Same path supports sub-agent dispatch (via the new sub-agent catalog tools, also this release).
