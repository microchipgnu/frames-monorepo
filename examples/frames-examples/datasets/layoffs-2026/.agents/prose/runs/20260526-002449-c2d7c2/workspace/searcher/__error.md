---
error: AllCallsFailed
node: searcher
---

# searcher: AllCallsFailed

All 4 planned paid calls (q1-exa-news-broad, q2-exa-warn-8k, q3-exa-ai-restructure, q4-twitter-official)
returned opaque `agentwallet 500` errors on the base/USDC rail (eip155:8453, 0.01 USDC each, recipient
0xe62923133a417cEe4241677865Ed5a63F44F4B54). Zero settlements; spent_usd=$0.00.

Error kind: opaque agentwallet 500 (NOT typed insufficient_funds), so per the documented strategy no
retries were attempted — this matches the prior-run intel about base/USDC opaque 500s for exa_search
and twitter_search. The pay client never reached a settled state for any call (attempts=1, paid=false
in every response).

Wallet preflight was clean: both `base` and `solana-mainnet` agentwallet wallets are configured.
The failure is downstream in the pay→agentwallet dispatch on base/USDC, not a wallet-readiness issue.

See raw_results.json for per-call detail (truncated error bodies retained for diagnostics).
