# Upstreaming `payment-tempo` to faremeter

This package is built faremeter-shaped on purpose. Once validated against a real Tempo MPP endpoint, the path is to merge it into [faremeter/faremeter](https://github.com/faremeter/faremeter) as `packages/payment-tempo/charge`.

## Why

Faremeter ships MPP support but only for the **Solana** flavor (`createMPPSolanaChargeClient`). Most real-world MPP services on the wire — including the entire `mpp.dev` directory and Frames Registry's MPP path — advertise `method="tempo"` (Stripe's L2). They are **unpayable through faremeter today**.

This package closes that gap with ~80 LOC of bridging code on top of [`mppx`](https://github.com/wevm/mppx) (wevm's official MPP SDK, which already implements all the actual signing / transaction building for Tempo).

## What this PR adds

A new package `@faremeter/payment-tempo` with:

- `charge/client.ts` — `createMPPTempoChargeClient(args)` returning an `MPPPaymentHandler` for tempo.charge intent. Mirror of `payment-solana/charge/client.ts`'s structure.
- `charge/index.ts` — public exports.
- `index.ts` — re-exports + `viem/chains` Tempo chain configs.

No server-side code (the server is mppx itself, already published).

## Reference materials

- **Template:** [`packages/payment-solana/src/charge/client.ts`](https://github.com/faremeter/faremeter/blob/main/packages/payment-solana/src/charge/client.ts) — same `MPPPaymentHandler` interface, same parsing shape, just chain-swapped.
- **Production-quality reference:** [`websets-impl/packages/wallet-mpp/src/mpp-provider-client.ts`](https://github.com/microchipgnu/websets-impl) (~1,000 LOC) — covers both `tempo.charge` and `tempo.session`. Documents the [`account.source` quirk](https://github.com/microchipgnu/websets-impl/blob/main/packages/wallet-signer-ows/src/tempo-account.ts) that Tempo's `prepareTransactionRequest` requires for legacy-tx-compatible requests (only matters for `tempo.session`; charge works with plain `LocalAccount`).
- **mppx tempo client:** [`mppx/dist/tempo/client/Charge`](https://github.com/wevm/mppx) — the underlying SDK doing the actual signing.

## Testing status

- ✅ **Structural smoke** (`bun smoke`) passes. Verifies routing for: non-tempo challenge → null, tempo session → null (we only handle charge), tempo charge → Execer returned, malformed request → null.
- ❌ **End-to-end against a real Tempo MPP endpoint** — pending. Two blockers:
  - **Tempo Devnet MPP seller** does not exist yet in any catalog we can find. viem ships `tempoDevnet` (chain 31318) so the wallet side works; need a seller to validate against.
  - **Tempo Mainnet** sellers exist (`mpp.dev/Firecrawl`, `mpp.dev/Brave Search`, registry.frames.ag's MPP path) but funding a Tempo wallet requires Stripe-side bridging — non-trivial provisioning.

Suggest faremeter team has access to either (a) a Devnet test endpoint or (b) an internal Tempo wallet for review-time validation.

## Restructuring needed for the PR

The current package layout matches faremeter's convention but uses npm dependencies rather than pnpm workspace catalog. To upstream:

| Item | Current | Needed for upstream |
|---|---|---|
| Layout | `src/charge/client.ts`, `src/charge/index.ts`, `src/index.ts` | unchanged ✓ |
| `package.json` name | `@frames-ag/payment-tempo` | `@faremeter/payment-tempo` |
| Dependencies | npm versions (`viem ^2.48.8`, etc.) | `catalog:` / `workspace:^` per faremeter convention |
| License | UNLICENSED | `LGPL-3.0-only` (matches other faremeter packages) |
| Build | none (Bun runs TS) | `tsc` + `tsc-esm-fix` per faremeter's pipeline |
| Tests | structural smoke (Bun) | rewrite as `tap` tests per faremeter convention |
| Workspace registration | n/a | add to `pnpm-workspace.yaml` + root `package.json` |

## Submission steps (manual)

```bash
# 1. Fork faremeter/faremeter
gh repo fork faremeter/faremeter --clone --remote
cd faremeter

# 2. Create branch
git checkout -b add-payment-tempo

# 3. Copy structure from this repo
mkdir -p packages/payment-tempo/src/charge
cp /path/to/payment-tempo/src/charge/client.ts packages/payment-tempo/src/charge/
cp /path/to/payment-tempo/src/charge/index.ts packages/payment-tempo/src/charge/
cp /path/to/payment-tempo/src/index.ts packages/payment-tempo/src/

# 4. Mirror their package.json conventions
#    (see packages/payment-solana/package.json as the template — license, scripts, tsconfig path,
#     workspace dep refs, devDeps via catalog)

# 5. Register in pnpm-workspace.yaml
echo '  - packages/payment-tempo' >> pnpm-workspace.yaml

# 6. pnpm install + verify build
pnpm install
pnpm --filter @faremeter/payment-tempo build
pnpm --filter @faremeter/payment-tempo test

# 7. Open PR with the description from PR_BODY.md below
gh pr create --title "feat(payment-tempo): add MPP Tempo charge client" --body-file PR_BODY.md
```

## PR Body (paste into GitHub)

```markdown
Adds `@faremeter/payment-tempo` — a client-side handler for the MPP `tempo.charge` intent, completing the matrix alongside `@faremeter/payment-solana/charge`.

Wraps [`mppx`](https://github.com/wevm/mppx) (the official MPP SDK from wevm) into faremeter's `MPPPaymentHandler` interface. ~80 LOC of bridging code; mppx does all the actual Tempo signing.

## Why

Faremeter ships MPP-Solana but no MPP-Tempo client. Most real MPP services advertise `method="tempo"` — including the entire mpp.dev directory and Frames Registry's MPP path. This unblocks them.

## What's in this PR

- New package: `packages/payment-tempo/`
- One handler factory: `createMPPTempoChargeClient({ account, mode?, clientId? })`
- Returns `MPPPaymentHandler` per `@faremeter/types/mpp` interface
- Composes with `wrap(fetch, { mppHandlers: [...] })`

## Tested

- Structural smoke passes (5 routing assertions).
- End-to-end against a real Tempo MPP endpoint is pending — would appreciate guidance on whether faremeter has internal test infrastructure for Tempo, or a recommended public Devnet seller. Currently using viem's `tempoDevnet` (chain 31318) on the wallet side.

## Reference

The production-quality reference for both `tempo.charge` and `tempo.session` lives in [websets-impl's wallet-mpp](https://github.com/microchipgnu/websets-impl/blob/main/packages/wallet-mpp/src/mpp-provider-client.ts) — that's where the design considerations (account.source quirk, channel persistence, fee_payer handling) were first worked out.

This PR upstreams only the simpler `charge` intent. `session` (per-token streaming) requires more state management and the Tempo-native Account adapter; happy to follow up with that as a separate PR.
```

## Standalone vs upstream tradeoffs

If upstreaming proves slow:

- **Keep as `@frames-ag/payment-tempo`** — already published-shaped. Pay's bridge can dynamic-import either `@faremeter/payment-tempo` or `@frames-ag/payment-tempo` (whichever resolves).
- **Re-package as a faremeter community plugin** — if faremeter exposes a plugin registration API later.

The architecture survives either decision because pay's bridge already discriminates by `descriptor.payment.protocol`, not by which npm package provides the handler.
