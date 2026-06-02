---
"@frames-ag/pay": patch
---

Send agentwallet's `preferredChain`/`preferredToken` hints instead of the ignored `payment_rail` field on delegated dispatch.

agentwallet's `/actions/x402/fetch` honors `preferredChain` (`'evm' | 'solana' | 'auto'`) and `preferredToken`; it never read `payment_rail`, so the rail the dispatcher selected was silently dropped and agentwallet fell back to its `auto` default (which can route a Base/USDC selection onto an MPP/Tempo challenge). The dispatcher now translates the descriptor's `payment.network` into agentwallet's enum (`base`/`eip155:*` → `evm`, `solana*` → `solana`) and forwards `payment.currency` as `preferredToken`, so the chosen chain is the one that settles. Also maps `eip155:4217|42431` → `tempo` in `mapChainToNetwork` for correct receipt labeling.
