# payment-tempo

MPP Tempo charge client for [Faremeter](https://github.com/faremeter/faremeter) — wraps [`mppx`](https://github.com/wevm/mppx) into a faremeter `MPPPaymentHandler` so [`@faremeter/fetch`](https://docs.faremeter.xyz/client/fetch-wrapper)'s `wrap()` can auto-handle `tempo.charge` 402s alongside x402.

Architecturally analogous to [`@faremeter/payment-solana/charge`](https://docs.faremeter.xyz/api/payment-solana.src.Namespace.charge) but for Tempo (Stripe's L2). All the actual signing and transaction building is done by mppx — this package is a ~80 LOC adapter between two type vocabularies.

## Why

Faremeter's MPP support today ships only the Solana flavor (`createMPPSolanaChargeClient`). Most real-world MPP services on the wire (Frames Registry, mpp.dev's Firecrawl, Brave Search, etc.) advertise `method="tempo"` and were unpayable through faremeter alone. This package closes that gap.

## Install

```bash
bun add @frames-ag/payment-tempo @faremeter/fetch viem mppx
```

## Use

```ts
import { wrap } from "@faremeter/fetch";
import { createMPPTempoChargeClient } from "@frames-ag/payment-tempo";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.TEMPO_PRIVATE_KEY as `0x${string}`);

const fetchPaid = wrap(fetch, {
  handlers: [],
  mppHandlers: [createMPPTempoChargeClient({ account })],
});

const res = await fetchPaid("https://api.firecrawl.dev/v1/scrape", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com" }),
});
// On 402 with WWW-Authenticate: Payment, this handler signs a Tempo
// USDC transfer via mppx, attaches the credential, and retries.
```

Stack with x402 handlers; faremeter routes per challenge:

```ts
const fetchPaid = wrap(fetch, {
  handlers: [
    createPaymentHandler(evmWallet),         // x402 EVM
    createPaymentHandler(solanaWallet, mint) // x402 Solana
  ],
  mppHandlers: [
    createMPPTempoChargeClient({ account }),  // MPP Tempo charge
    createMPPSolanaChargeClient({ wallet, mint }), // MPP Solana charge
  ],
});
```

## API

### `createMPPTempoChargeClient(args)`

Returns an `MPPPaymentHandler` that accepts `tempo.charge` challenges.

| Arg | Type | Description |
|---|---|---|
| `account` | `viem.Account` | viem account (any LocalAccount, e.g. from `privateKeyToAccount`) |
| `mode?` | `"push" \| "pull"` | Override transaction submission mode. Defaults to push for JSON-RPC accounts, pull for local accounts |
| `clientId?` | `string` | Client identifier baked into attribution memos |

Returns `null` for any challenge whose `method !== "tempo"` or `intent !== "charge"`. faremeter's fetch wrap then tries the next handler.

## Status

- ✅ Structural smoke passes (`bun smoke`) — null cases, valid challenges, malformed requests all routed correctly
- ⏳ End-to-end Tempo Devnet smoke pending a public Devnet MPP seller
- ⏳ End-to-end Tempo Mainnet smoke pending a funded Tempo wallet (Stripe-side bridge flow)

## Roadmap to upstreaming

This package is built faremeter-shaped on purpose so it can be upstreamed as `packages/payment-tempo/charge` (or similar) in [faremeter/faremeter](https://github.com/faremeter/faremeter). Steps:

1. Validate against a real Tempo charge endpoint
2. Mirror exact code style of `payment-solana/charge`
3. Open PR

Until then it lives standalone under `@frames-ag/payment-tempo`.

## Reference material

- [`@faremeter/payment-solana/charge/client.ts`](https://github.com/faremeter/faremeter/blob/main/packages/payment-solana/src/charge/client.ts) — the structural template this mirrors
- [`mppx/client/Charge`](https://github.com/wevm/mppx) — the underlying SDK doing the actual Tempo signing
- [`@websets/wallet-mpp/mpp-provider-client.ts`](https://github.com/microchipgnu/websets-impl/blob/main/packages/wallet-mpp/src/mpp-provider-client.ts) — production-quality MPP client (mppx-based) that informed this design
