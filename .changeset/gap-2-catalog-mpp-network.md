---
"@frames-ag/catalog": patch
---

MPP-mirrored descriptors now carry `payment.network`.

The catalog refresh script previously dropped MPP endpoints' `payment.method` field (which names the network, e.g. `"tempo"`), leaving ~669 descriptors unusable by pay-mcp — every dispatch failed with `no_wallet_for_network — "(missing)"`.

Fix in `scripts/refresh.ts`: the `MppService.endpoints[].payment` type now includes the upstream's `method` field, and `mppToDescriptors` maps it to the descriptor's `payment.network`. Asset propagation also added: pulls from `service.methods[<network>].assets[0]` when the endpoint's `currency` doesn't already encode the asset.

After re-running `bun run refresh`, the live catalog at `https://catalog.microchipgnu.workers.dev` will surface working MPP descriptors. Verified: `mpp.stableenrich.post.api-{serper-news, reddit-search, firecrawl-scrape}` all now have `"network": "tempo"`.

This is a catalog-side fix; pay's wallet-config side still needs a `tempo` network entry for those descriptors to actually pay (separate from this change).
