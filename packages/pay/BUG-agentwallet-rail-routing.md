# Bug: Base/Solana rail hint is ignored; agentwallet settles dual-advertising sellers on Tempo

**Status:** fix implemented (both repos) + regression tests added; pending deploy of agentwallet
service and release of `@frames-ag/pay`, then a live Base settlement check.
**Filed:** 2026-06-01 (updated 2026-06-02 with agentwallet server root cause + implemented fix)

## Fix implemented (2026-06-02)

- **Client** `packages/pay/src/wallet/dispatch.ts` (`dispatchViaAgentwallet`): translate the
  selected descriptor network into agentwallet's schema — `preferredChain` (`base`/`eip155:*`→`evm`,
  `solana*`→`solana`) + `preferredToken` (from `payment.currency`) — instead of relying on the
  stripped `payment_rail`. Added `toAgentwalletChain()` and `eip155:4217|42431 → tempo` in
  `mapChainToNetwork`. Tests: `packages/pay/test/agentwallet-rail-hint.test.ts` (3, passing).
- **Server** `agentwallet-mcpay/lib/x402/fetch.ts`: the MPP-first branch now skips MPP/Tempo when
  `request.preferredChain` is explicitly `evm`/`solana` (≠`auto`), falling through to the x402
  `accepts[]` selection. Tests: `lib/x402/fetch.mpp.test.ts` (+2, suite 23 passing).
- Verified: `packages/pay` `tsc --noEmit` clean; agentwallet route vitest 14/14; mpp vitest 23/23.
- Remaining: deploy agentwallet to frames.ag + release the pay client, then re-run the Base/USDC
  descriptor test below and confirm `payment.chain == eip155:8453` (Base wallet holds ~0.94 USDC).
**Components:**
- `packages/pay` (client) — `src/wallet/dispatch.ts`
- agentwallet service (`~/code/agentwallet-mcpay`) — `lib/x402/fetch.ts`, `app/api/wallets/[username]/actions/x402/fetch/route.ts`

**Severity:** high — a seller that natively accepts Base/Solana USDC (rails the user holds) is paid on Tempo instead, and Base/USDC cannot be forced.

## Summary

Two defects compound:

1. **Client never sends agentwallet's chain hint.** `/x402/fetch` accepts
   `preferredChain: 'evm' | 'solana' | 'auto'` and `preferredToken`. pay sends neither — it sends
   a field named **`payment_rail`** that is not in agentwallet's request schema, so Zod strips it.
   agentwallet therefore always runs in `preferredChain: 'auto'`.

2. **agentwallet prefers an MPP/Tempo challenge over x402 Base/Solana, before consulting the hint.**
   For a seller whose 402 advertises **both** an MPP (`www-authenticate`, Tempo) challenge **and**
   x402v2 `accepts[]` (Base + Solana USDC) — which is exactly what `stablesocial.dev` does —
   agentwallet takes the MPP/Tempo branch whenever the MPP challenge is a Tempo chain, *before* the
   `preferredChain`/balance selection runs and *without* looking at `preferredChain` at all.

Result: payment settles on **Tempo Mainnet (`eip155:4217`), USDC.e, protocol `mpp`**, regardless
of the descriptor rail or any client intent. The earlier hypothesis ("agentwallet has no rail
hint") was wrong — the hint exists (`preferredChain`); it's just (a) never sent by the client and
(b) bypassed by the MPP-first branch for dual-advertising sellers.

## Environment / repro

- `~/.frames/pay/config.yaml`: `base` and `solana-mainnet` both `{ kind: agentwallet, label: my-agentwallet }`.
- agentwallet `my-agentwallet` holds ~`0.011976` USDC.e on Tempo; Base/Solana USDC balances unconfirmed.
- Seller: `https://stablesocial.dev/api/facebook/search-groups` ($0.06). Its live 402 carries:
  - `payment-required` (x402v2): accepts **Base USDC** `eip155:8453` (`0x833589…2913`, payTo `0xCfA2…4dbE`) **and Solana USDC** `solana:5eykt4…`.
  - `www-authenticate: Payment … method="tempo"` (MPP/Tempo challenge).
- Paying via a hand-authored **Base/USDC descriptor** (so pay *selected* `x402v2/base/USDC`) still produced:
  ```json
  { "success": false, "paid": false,
    "payment": { "chain": "eip155:4217", "amountFormatted": "0.06 USDC.e",
                 "recipient": "0xCfA26F13c6C18307033EcE13BBb8F470dA5b4dbE", "tokenSymbol": "USDC.e" },
    "error": "Insufficient USDC.e balance on Tempo Mainnet. Wallet has 0.011976, but payment requires 0.060000.",
    "errorCode": "INSUFFICIENT_BALANCE", "protocol": "mpp" }
  ```
  pay asked for Base; agentwallet executed MPP/Tempo.

## Root cause — exact locations

### Client: `packages/pay/src/wallet/dispatch.ts` → `dispatchViaAgentwallet` (~lines 644-657)

```ts
const reqBody: Record<string, unknown> = { url, method, body };
if (descriptor.payment.network) {
  reqBody["payment_rail"] = { protocol, network, currency, asset };  // ← not in agentwallet schema
}
```

`payment_rail` is unknown to agentwallet's `RequestSchema` and is stripped. `preferredChain` /
`preferredToken` are never set, so agentwallet defaults to `auto`.

### Server: `~/code/agentwallet-mcpay`

Request schema — `app/api/wallets/[username]/actions/x402/fetch/route.ts:32-43`:
```ts
const RequestSchema = z.object({
  url, method, headers, body,
  preferredChain: z.enum(['evm','solana','auto']).optional().default('auto'),
  preferredToken: z.string().optional(),
  walletAddress:  z.string().optional(),
  ...
});
```
So the supported hints are `preferredChain`, `preferredToken`, `walletAddress` — NOT `payment_rail`.

MPP-first branch — `lib/x402/fetch.ts:302-340`:
```ts
const protocol = detectPaymentProtocol(response);
if (protocol === 'mpp') {
  // only skips MPP if the challenge chainId is NON-Tempo:
  if (challenge.chainId && !isTempoChainId(challenge.chainId)) usesMpp = false;
  if (usesMpp) return handleMppPayment(response, { ... });   // ← settles Tempo, ignores preferredChain
}
// ...only here (line ~410+) does preferredChain / balance auto-selection run for the x402 path
```

For `stablesocial.dev`, `detectPaymentProtocol` sees the MPP `www-authenticate` header → `protocol = 'mpp'`,
the challenge is Tempo (`4217`) → `usesMpp = true` → `handleMppPayment` → Tempo. `preferredChain` is
never consulted on this path.

## Proposed fixes

**Client (this repo) — `packages/pay/src/wallet/dispatch.ts`:** replace the `payment_rail` body key
with agentwallet's real hints. Map the selected option:
```ts
// network → preferredChain
const pc = /^eip155:|^base/.test(network) ? "evm"
         : /^solana/.test(network)        ? "solana"
         : undefined;
if (pc) reqBody["preferredChain"] = pc;
if (descriptor.payment.currency) reqBody["preferredToken"] = descriptor.payment.currency; // e.g. "USDC"
// optional: pin the exact wallet
// reqBody["walletAddress"] = registry.addressFor(network);
```
This alone fixes x402-only sellers (no MPP header) immediately.

**Server (`agentwallet-mcpay`) — `lib/x402/fetch.ts`:** consult the hint *before* the MPP-first
branch. If `request.preferredChain` is explicitly `'evm'`/`'solana'` (not `'auto'`), or
`preferredToken` excludes the MPP token, do **not** hijack to MPP/Tempo even when a Tempo MPP
challenge is present — fall through to the x402 `accepts[]` matching the requested chain. i.e. gate
line 308 on `protocol === 'mpp' && (preferredChain === 'auto' || preferredChain == null)`.
This is required for dual-advertising sellers like StableSocial; the client fix is not sufficient
on its own for them.

**Both are needed** for StableSocial-on-Base. Client fix + server gate ⇒ `preferredChain:'evm'`
routes to the seller's Base USDC accept and signs from the Base wallet.

## Faster interim unblocks

- Top up agentwallet **Tempo USDC.e** ≥ call price → works today, but keeps everything on Tempo.
- Or fund the agentwallet **Base** wallet with USDC *and* ship the server gate above (so `auto`
  balance-selection — or an explicit `preferredChain:'evm'` — can actually pick Base).

## Acceptance check

Re-run the Base/USDC descriptor for `stablesocial.dev/api/facebook/search-groups` with the client
sending `preferredChain:'evm'`, `preferredToken:'USDC'`, the server gate in place, and the Base
wallet funded. Expect: `payment.chain == "eip155:8453"`, `tokenSymbol == "USDC"`, success,
receipt `network: "base"`, no Tempo.

## Secondary client cleanups (unchanged from first pass)

- `mapChainToNetwork` (dispatch.ts:763) has no `eip155:4217 → tempo` entry.
- Delegated wallets bypass the selection-time balance check (dispatch.ts:528-531), so funding
  problems only surface as a dispatch-time 500.
- Consider a typed `rail_override_by_provider` error when executed `payment.chain` ≠ selected network.
