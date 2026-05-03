# pay protocol v0.0.1

The wire formats and interface contracts for the buyer side of paid agent tool calls. Implementers honoring this spec interoperate with each other regardless of language or runtime.

This document specifies the contracts. It does not specify how those contracts are implemented — that's [PLAN.md](./PLAN.md) and the source.

## Versioning

Semver. Implementations declare the version they target via a `pay_protocol` field on every contract that ships across the wire (catalog responses, receipts, descriptors).

- **Patch** (0.0.1 → 0.0.2): clarifications, no wire change.
- **Minor** (0.1.0 → 0.2.0): new optional fields. Older readers must skip unknowns.
- **Major** (0.x → 1.0): breaking change.

## Tool descriptor

The unit a catalog returns and a wallet consumes. JSON. **Content-addressed** by SHA-256 of its canonical encoding.

```json
{
  "pay_protocol": "0.0.1",
  "id": "search.exa",
  "title": "Exa web search",
  "description": "Neural search across the public web. Returns ranked URLs with snippets.",
  "capabilities": ["web-search"],
  "invocation": {
    "method": "POST",
    "url": "https://api.exa.ai/search",
    "params_schema": { "$ref": "#/schemas/ExaSearchParams" }
  },
  "payment": {
    "protocol": "x402",
    "network": "base",
    "currency": "USDC",
    "price_hint": "0.01"
  },
  "schemas": { "ExaSearchParams": { "type": "object", "...": "..." } }
}
```

| field | required | description |
|---|---|---|
| `pay_protocol` | yes | semver of the spec this descriptor conforms to |
| `id` | yes | stable, slug-shaped: `[a-z0-9][a-z0-9._-]*`. Globally unique within the publishing catalog |
| `title` | yes | short human label |
| `description` | yes | what the tool does, in prose. Fed to agents |
| `capabilities` | yes | tags an agent matches against (`web-search`, `image-gen`, `scrape`, …). At least one |
| `invocation` | yes | how to call it. `method`, `url`, `params_schema` (JSON Schema) |
| `payment` | yes | `protocol` (string ID), plus protocol-specific fields. `price_hint` is advisory; the seller's 402 challenge is authoritative |
| `schemas` | no | inline JSON Schema definitions referenced by `invocation.params_schema` |

Unknown fields must be preserved when forwarded and ignored when not understood.

### Descriptor identity

The `descriptor_id` of a tool is the SHA-256 of its canonical JSON encoding (RFC 8785 / JCS). It is computed, never declared.

```
descriptor_id := "sha256-" + base64url(sha256(jcs(descriptor)))
```

The `descriptor_id` field is *never present* in the descriptor itself — it would create a circular dependency. It is computed at the moment of resolution and stored alongside the descriptor in lock files, receipts, and event logs.

`id` is the publisher's name for the tool (`search.exa`). `descriptor_id` is the cryptographic identity of *this exact version of that tool*. The pair `(catalog_url, id)` is mutable; `descriptor_id` is immutable. Lock files and receipts MUST reference `descriptor_id`. Manifests MAY reference by URL alone — the lock file pins the SHA on first resolution.

## Manifest and lock file

A consumer (typically a frame dataset, but any project) declares its tool dependencies in a manifest, and pins them in a lock file. Same shape as `package.json` + `package-lock.json`.

### `tools.yml` — the manifest

```yaml
pay_protocol: 0.0.1
tools:
  search:
    url: https://catalog.frames.ag/tools/search.exa
  enrich:
    url: https://github.com/firecrawl/firecrawl/raw/main/tool.json
    integrity: sha256-Def456...    # optional; if present, fails on mismatch
  scrape:
    path: ./tools/local-scrape.json   # local descriptors are first-class
```

| field | required | description |
|---|---|---|
| `pay_protocol` | yes | semver of the spec this manifest conforms to |
| `tools` | yes | map of *local name* → tool reference. Local names are how the consumer calls tools (`pay run search`); they need not match the descriptor's `id` |
| `tools.<name>.url` | one of | URL to fetch the descriptor from |
| `tools.<name>.path` | one of | local filesystem path to a descriptor file |
| `tools.<name>.integrity` | no | if set, resolution fails when the fetched descriptor's SHA doesn't match. Otherwise pinned on first install |

The manifest is human-edited. The lock file is generated.

### `tools.lock` — the lock file

```json
{
  "pay_protocol": "0.0.1",
  "lockfile_version": 1,
  "resolved": {
    "search": {
      "source": { "url": "https://catalog.frames.ag/tools/search.exa" },
      "descriptor_id": "sha256-Abc123...",
      "fetched_at": "2026-05-03T10:00:00.000Z",
      "descriptor": { "...inlined ToolDescriptor..." }
    },
    "enrich": {
      "source": { "url": "https://github.com/firecrawl/firecrawl/raw/main/tool.json" },
      "descriptor_id": "sha256-Def456...",
      "fetched_at": "2026-05-03T10:00:00.000Z",
      "descriptor": { "...inlined..." }
    }
  }
}
```

The lock file inlines full descriptors. A fresh clone is offline-runnable: `pay run search --params …` resolves the local name from the lock, validates, and calls — no network needed for discovery.

### Resolution algorithm

When the wallet is asked to call a tool by *local name*:

1. If `tools.lock` is present and contains the name: use the inlined descriptor. Verify `sha256(jcs(descriptor)) == descriptor_id`. Fail if not.
2. If no lock entry exists and the manifest is present: fetch the URL/path, compute `descriptor_id`, verify against `integrity` if declared, write a lock entry, then proceed.
3. If neither is present: fail. The wallet only resolves bare descriptor IDs or URLs in explicit-call modes (`pay tool <url> --params …`), never implicitly.

This makes every paid call deterministic and replayable from a committed lock file.

### Manifest scope

The manifest lives at the root of any project that uses paid tools. For frame datasets, the conventional location is `tools.yml` next to `schema.yml`. The lock file is committed alongside it.

## Catalog HTTP shape

A catalog is any HTTP endpoint serving descriptors. Three required routes:

```
GET /catalog                          → ListResponse
GET /catalog/:id                      → ToolDescriptor
GET /catalog?capability=<tag>         → ListResponse (filtered)
```

`ListResponse`:

```json
{
  "pay_protocol": "0.0.1",
  "tools": [ToolDescriptor, ...],
  "cursor": "opaque-or-null"
}
```

| Constraint | Value |
|---|---|
| Pagination | cursor-based; `?cursor=<opaque>&limit=<n≤500>` |
| Caching | `ETag: W/"<sha12>"` on every response. `Cache-Control: public, s-maxage=60, stale-while-revalidate=600` |
| Errors | RFC 9457 problem+json. `404` for unknown ID; `400` for bad cursor |

A catalog is read-only over HTTP. Writes happen out of band (git push, admin API, manual edit).

## CatalogSource interface

The library-side interface. Any class implementing this can be plugged into a `Wallet` as a discovery source.

```ts
interface CatalogSource {
  id: string;                                    // stable identifier for this source
  list(filter?: { capability?: string; cursor?: string; limit?: number }): Promise<{
    tools: ToolDescriptor[];
    cursor?: string;
  }>;
  get(toolId: string): Promise<ToolDescriptor | null>;
}
```

Implementations ship in this repo:
- `StaticCatalog` — descriptors from an in-memory array or local JSON file
- `HttpCatalog` — speaks the catalog HTTP shape above
- `McpCatalog` — treats an MCP server's tool list as catalog entries

A `FederatedCatalog` aggregates multiple sources. Federation is opt-in; single-source consumers should use the source directly.

## Wallets and protocols (faremeter)

Pay does not define its own signer or protocol-client interfaces. It delegates the entire wire layer — wallet signing, x402/MPP negotiation, HTTP retry — to **[faremeter](https://docs.faremeter.xyz)**, the reference implementation of the x402 protocol family.

A pay `Wallet` holds:

- A **wallet registry**: faremeter wallet objects keyed by network. A user may configure multiple (e.g. an OWS-backed Solana wallet for `solana-mainnet`, an OWS-backed EVM wallet for `base`).
- A **handler factory**: given a `descriptor.payment`, constructs the appropriate `@faremeter/payment-*` handler bound to the wallet for that network.

### Protocol mapping

`descriptor.payment.protocol` is a discriminator. Pay's bridge maps it to a faremeter handler family:

| `payment.protocol` | Faremeter handler | Wire spec |
|---|---|---|
| `x402` | `@faremeter/payment-{evm,solana}/exact` | x402 v1 |
| `x402v2` | x402v2 handler (same factory shape, v2 headers: `PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`) | x402 v2 |
| `mpp` | `MPPMethodHandler` chain via `@faremeter/fetch` | MPP (`Authorization: Payment` + `WWW-Authenticate`) |

A pay v0.0.1 implementation MUST support `x402`. `x402v2` and `mpp` are optional in v0.0.1 and become required in v0.1.0 once faremeter's MPP handler ships full intent coverage.

### Wallet contract

Pay accepts any object satisfying the relevant faremeter wallet shape for its network. Today that means:

- **EVM** (`@faremeter/wallet-evm`, `@faremeter/wallet-ows` EVM, `@faremeter/wallet-ledger` EVM, `@faremeter/wallet-crossmint`): an object with `chain`, `address`, and `account.signTypedData(...)`.
- **Solana** (`@faremeter/wallet-solana`, `@faremeter/wallet-ows` Solana, `@faremeter/wallet-solana-squads`, `@faremeter/wallet-ledger` Solana): an object with `network`, `publicKey`, `partiallySignTransaction(...)`, `updateTransaction(...)`.

Pay does not import or re-export these shapes. Callers construct wallets directly from faremeter and pass them to pay's wallet registry. New wallet types added to faremeter (Privy, Turnkey, future hardware) become usable by pay with no pay-side change.

### Pre-flight balance checks

Pay's budget enforcement may use faremeter's balance helpers (`getTokenBalance` for SPL on Solana, the EVM equivalent) to surface low-balance warnings before signing. These checks are advisory — the seller's 402 challenge remains authoritative on price.

## Receipt

Append-only proof that a paid call happened. JSON object, content-addressed by SHA-256 of the canonical encoding.

```json
{
  "pay_protocol": "0.0.1",
  "id": "01HK...",
  "ts": "2026-05-02T14:22:11.000Z",
  "tool_local_name": "search",
  "tool_id": "search.exa",
  "descriptor_id": "sha256-Abc123...",
  "protocol": "x402",
  "wallet_id": "ows:my-base-wallet",
  "wallet_address": "0xabc...",
  "amount": "0.01",
  "currency": "USDC",
  "network": "base",
  "facilitator_url": "https://facilitator.corbits.dev",
  "tx_hash": "0xabc...",
  "request_hash": "sha256-...",
  "response_hash": "sha256-...",
  "agent": "claude:opus-4.7"
}
```

| field | required | description |
|---|---|---|
| `descriptor_id` | yes | the SHA of the descriptor that was used. Pinned in `tools.lock`. Forensic anchor — replays the exact tool spec |
| `tool_local_name` | no | the consumer's local name (`search`) when called via manifest |
| `tool_id` | yes | the publisher's name (`search.exa`) for human readability |
| `wallet_id` | yes | identifier of the faremeter wallet used: `<faremeter-package>:<user-label>`. E.g. `ows:my-base-wallet`, `crossmint:treasury` |
| `wallet_address` | yes | the on-chain address that signed |
| `facilitator_url` | yes | which facilitator settled the payment. Recorded for forensics — different facilitators have different finality guarantees |
| `tx_hash` | no | protocol-specific; absent for off-chain settlement |
| `agent` | yes | follows the `<kind>:<identifier>` convention from the frame protocol |

## Frame integration

When the consumer is a frame dataset, paid calls produce a first-class event in `events.ndjson`:

```json
{
  "id": "uuid-v4",
  "ts": "2026-05-03T...",
  "type": "tool.invoked",
  "agent": "claude:opus-4.7",
  "payload": {
    "tool_local_name": "search",
    "descriptor_id": "sha256-Abc123...",
    "params_hash": "sha256-...",
    "receipt_id": "01HK...",
    "amount": "0.01",
    "currency": "USDC"
  }
}
```

This is opt-in: pay does not require the frame protocol. But when both are present, the dataset becomes forensically complete — every fact names a source, every paid call names a descriptor SHA pinned in the lock file. Re-running a tick from any point in history is deterministic given the lock and the source URLs.

The `tool.invoked` event type is reserved by this spec; the frame protocol's "skip unknown event types" rule means frame implementations not aware of pay simply pass them through.

## WalletAdapter contract

The orchestrator. One method matters:

```ts
interface WalletAdapter {
  payForTool(input: {
    name: string;                                // local name from tools.yml, OR descriptor URL, OR descriptor_id
    params: unknown;
    manifest?: Manifest;                         // defaults to discovered tools.yml
    lock?: Lockfile;                             // defaults to discovered tools.lock
    catalog?: CatalogSource;                     // fallback if name is not in manifest
  }): Promise<{
    body: unknown;
    receipt: Receipt;
  }>;
}
```

Behavior, in order:

1. **Resolve** the descriptor:
   - If `name` matches a lock entry: use the inlined descriptor; verify `sha256(jcs(descriptor)) == descriptor_id` (fail on mismatch).
   - Else if `name` matches a manifest entry: fetch the URL/path, compute SHA, verify against `integrity` if declared, write a lock entry, proceed.
   - Else if `name` is a URL or `descriptor_id`: fetch and validate directly. No lock write — explicit-call mode.
   - Else if a `catalog` is bound: look up by `id`. No lock write.
2. Validate `params` against `descriptor.invocation.params_schema`.
3. Check budget (per-call, per-run, per-month). Optionally pre-flight balance check via faremeter helpers. Reject with `BudgetExceeded` or `InsufficientBalance` before signing.
4. Look up the faremeter wallet for `descriptor.payment.network` from the wallet registry. Fail with `NoWalletForNetwork` if none configured.
5. Map `descriptor.payment.protocol` to the appropriate `@faremeter/payment-*` handler factory; instantiate the handler bound to the wallet.
6. Build the `ResolvedInvocation` (URL, method, body, headers) from descriptor + params.
7. Call `wrap(fetch, { handlers: [handler] })` and execute the invocation. Faremeter handles the 402 round-trip, signing, settlement, and `X-PAYMENT` / `Authorization: Payment` header attachment.
8. Append the receipt to the audit log and ledger. If a frame dataset is the consumer, also append a `tool.invoked` event to its `events.ndjson`.
9. Return `{ body, receipt }`.

Failure between step 7 and 9 must be recovered by sync-flushing the receipt before the HTTP call returns to the caller. A receipt-without-call is recoverable; a call-without-receipt is not.

## Storage interfaces

Three interfaces. No filesystem assumption in core.

```ts
interface LedgerStore       { append(entry: LedgerEntry): Promise<void>;   list(...): Promise<LedgerEntry[]>; }
interface WalletStateStore  { get(key: string): Promise<unknown>;          set(key, value): Promise<void>; }
interface AuditLogStore     { append(receipt: Receipt): Promise<void>;     list(...): Promise<Receipt[]>; }
```

Two default implementations ship: `MemoryStore` (tests) and `FilesystemStore` (default for local users, NDJSON files under `~/.frames/pay/`).

Cloud implementations (Redis, Postgres, R2, KV) are out of scope for this spec — they implement the same interfaces.

## Canonical encoding

Wherever this spec says "SHA-256 of the canonical encoding," the encoding is **JSON Canonicalization Scheme (RFC 8785 / JCS)**: UTF-8, sorted object keys, no insignificant whitespace, normalized number representation. Two implementations of pay must compute the same `descriptor_id` and `request_hash` for the same input — JCS is the only normalization required to guarantee that.

## Conformance

A conformant **buyer-side implementation** of `pay` v0.0.1:

1. Reads and writes tool descriptors per the schema above.
2. Computes `descriptor_id` via `sha256(jcs(descriptor))`.
3. Reads `tools.yml` and `tools.lock` per the manifest format.
4. Implements the `WalletAdapter` resolution algorithm in the order specified.
5. Delegates wire-level signing and 402 negotiation to faremeter (`@faremeter/fetch` + `@faremeter/payment-*` + `@faremeter/wallet-*`).
6. Produces receipts conforming to the receipt schema, including `descriptor_id`, `wallet_id`, and `facilitator_url`.
7. Sync-flushes receipts before returning paid call results to callers.
8. Supports `descriptor.payment.protocol == "x402"`. MAY support `x402v2` and `mpp`.

A conformant **catalog server** (publisher):

1. Serves the three required HTTP routes.
2. Returns `ListResponse` and `ToolDescriptor` JSON conforming to the schemas above.
3. Serves descriptors with stable URLs — once a `(catalog_url, id)` pair has served a descriptor with a given `descriptor_id`, the URL must keep returning a descriptor with that ID until the publisher explicitly publishes a new version. Callers rely on URL stability to know whether to re-pin.
4. Honors `ETag` / `If-None-Match` and the `Cache-Control` directives specified.
