---
error: AllCallsFailed
spent_usd: 0.0
budget_usd: 0.20
settled_count: 0
failed_count: 6
---

# AllCallsFailed

All 6 planned queries (4 exa_search + 2 twitter_search) failed without settlement. Zero USD spent.

## What failed

Every `mcp__pay__pay_tool` call returned `isError=true` with `error.kind=unknown` and the message:

> "no rail succeeded across 5 payment options"

The pay client's multi-rail fallback (added in commit baaa1774c) **did fire** — it iterated through all 5 advertised `payment.accepts[]` rails for each query:

1. x402v2/base/USDC
2. x402v2/base/USDT
3. x402v2/solana-mainnet/USDC
4. x402v2/solana-mainnet/USDT
5. x402v2/solana-mainnet/CASH

## What was tried

For each of the 6 queries, the client made one `pay_tool` call. Each call internally tried all 5 rail options. None settled.

## What kind of error

Opaque `agentwallet 500` on every rail attempt. **Critical diagnostic**: every option's actual outbound `payment` payload (visible in the truncated error bodies) was identical:

```
chain:     eip155:8453
amountRaw: 10000
currency:  USDC (amountFormatted: "0.01 USDC")
recipient: 0xe62923133a417cEe4241677865Ed5a63F44F4B54
```

This means the rail-fallback loop is **selecting** the next rail option, but the per-attempt payment payload sent to agentwallet is **never re-templated for the selected rail** — it always sends a base/USDC payment regardless of whether the loop currently picked solana-mainnet/CASH. Hence all 5 attempts collapse into 5 identical base/USDC dispatches, all of which 500 against agentwallet.

This matches the persisted note in user memory: *"pay multi-rail dispatch gap — catalog descriptors + solana wallet shipped, but pay→agentwallet dispatch still hard-picks base/USDC; opaque 500s not yet typed at MCP boundary."*

## Wallets

Both wallets are healthy and present:
- `base`: `agentwallet:my-agentwallet` `0xBd9EB8899d7207bEB35A140010E154438a25E55f`
- `solana-mainnet`: `agentwallet:my-agentwallet` `AyyQz8tScHpiAh7S3v8XXhxHbfvfSiErLGur11SmegRc`

## Sample truncated error body (q1)

```
agentwallet 500: {"success":false,"paid":false,"attempts":1,"duration":607,"payment":{"chain":"eip155:8453","amountRaw":"10000","amountFormatted":"0.01 USDC","recipient":"0xe62923133a417cEe4241677865Ed5a63F44F4B54","t...
```

(Body truncated by client at ~300 chars per option.)

## Suggested next steps for orchestrator

- Trigger shortfall.md path; do not refund (nothing was spent).
- The fix is upstream in the pay client (re-template the agentwallet payment payload per selected rail before dispatch), not in this run's plan.
- Re-running with the same plan will reproduce the failure verbatim.
