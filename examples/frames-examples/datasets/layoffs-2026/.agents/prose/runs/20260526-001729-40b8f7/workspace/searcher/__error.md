---
error: AllCallsFailed
node: searcher
---

# searcher: AllCallsFailed

Three planned paid calls were attempted, zero settled. All routed to
base/USDC (`chain: eip155:8453`) despite both `exa_search` and `twitter_search`
descriptors advertising 5 accepts (base USDC/USDT, solana USDC/USDT/CASH)
and a solana-mainnet wallet being configured in pay.

Per the service's strategy guidance, a typed `insufficient_funds` error would
have justified a single rail-preference retry. The errors here returned
opaque `agentwallet 500` (truncated body) — not a typed error — so no retry
was attempted. The downstream services (`extractor`, `dedup`) cannot satisfy
their contracts on empty input, so the run terminates at this node and
falls through to a system-level shortfall report.

See `bindings/searcher/raw_results.json` for the per-call diagnostics and
`bindings/discover/shortfall.md` for the run's exit report.
