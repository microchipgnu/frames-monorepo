# pay protocol v0.0.1

The wire formats and interface contracts for the buyer side of paid agent tool calls. Implementers honoring this spec interoperate with each other regardless of language or runtime.

This document specifies the contracts. It does not specify how those contracts are implemented — that's [PLAN.md](./PLAN.md) and the source.

## Versioning

Semver. Implementations declare the version they target via a `pay_protocol` field on every contract that ships across the wire (catalog responses, receipts, descriptors).

- **Patch** (0.0.1 → 0.0.2): clarifications, no wire change.
- **Minor** (0.1.0 → 0.2.0): new optional fields. Older readers must skip unknowns.
- **Major** (0.x → 1.0): breaking change.

## Tool descriptor

The unit a catalog returns and a wallet consumes. JSON.

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
| `id` | yes | stable, slug-shaped: `[a-z0-9][a-z0-9._-]*`. Globally unique within a catalog |
| `title` | yes | short human label |
| `description` | yes | what the tool does, in prose. Fed to agents |
| `capabilities` | yes | tags an agent matches against (`web-search`, `image-gen`, `scrape`, …). At least one |
| `invocation` | yes | how to call it. `method`, `url`, `params_schema` (JSON Schema) |
| `payment` | yes | `protocol` (string ID), plus protocol-specific fields. `price_hint` is advisory; the seller's 402 challenge is authoritative |
| `schemas` | no | inline JSON Schema definitions referenced by `invocation.params_schema` |

Unknown fields must be preserved when forwarded and ignored when not understood.

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

## Signer interface

Signers are pure key-and-signature factories. They do not know about HTTP, retry, or audit.

```ts
interface Signer {
  id: string;                                    // "ows", "kms", "privy", ...
  sign(payload: SigningRequest): Promise<SigningResult>;
  address(network: string): Promise<string>;     // chain-aware address
  capabilities(): SignerCapabilities;            // which networks/schemes supported
}
```

Signers are registered with a wallet by string ID and selected per-call based on the tool descriptor's `payment.network`.

## ProtocolClient interface

Protocols are HTTP wire-format implementations. They consume signers and produce paid call results.

```ts
interface ProtocolClient {
  id: string;                                    // "x402", "mpp", ...
  pay(input: {
    invocation: ResolvedInvocation;              // url, method, body, headers
    descriptor: ToolDescriptor;
    signer: Signer;
  }): Promise<PaidCallResult>;
}

type PaidCallResult = {
  status: number;
  body: unknown;
  receipt: Receipt;
};
```

A protocol owns the full request lifecycle: build, send, handle the 402 challenge, sign, retry with proof, settle, return the body and a receipt.

## Receipt

Append-only proof that a paid call happened. JSON object, content-addressed by SHA-256 of the canonical encoding.

```json
{
  "pay_protocol": "0.0.1",
  "id": "01HK...",
  "ts": "2026-05-02T14:22:11.000Z",
  "tool_id": "search.exa",
  "protocol": "x402",
  "signer_id": "ows",
  "amount": "0.01",
  "currency": "USDC",
  "network": "base",
  "tx_hash": "0xabc...",
  "request_hash": "sha256:...",
  "response_hash": "sha256:...",
  "agent": "claude:opus-4.7"
}
```

`tx_hash` is protocol-specific and may be absent for off-chain settlement. `agent` follows the same `<kind>:<identifier>` convention as the frame protocol.

## WalletAdapter contract

The orchestrator. One method matters:

```ts
interface WalletAdapter {
  payForTool(input: {
    toolId: string;
    params: unknown;
    catalog?: CatalogSource;                     // defaults to wallet's bound catalog
  }): Promise<{
    body: unknown;
    receipt: Receipt;
  }>;
}
```

Behavior, in order:

1. Resolve `toolId` via the catalog → `ToolDescriptor`.
2. Validate `params` against `descriptor.invocation.params_schema`.
3. Check budget (per-call, per-run, per-month). Reject with `BudgetExceeded` if over cap.
4. Pick the protocol from `descriptor.payment.protocol`.
5. Pick the signer for `descriptor.payment.network`.
6. Build the `ResolvedInvocation` from descriptor + params.
7. Call `protocol.pay(...)`.
8. Append the receipt to the audit log and ledger.
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

## Conformance

A conformant **buyer-side implementation** of `pay` v0.0.1:

1. Reads and writes tool descriptors per the schema above.
2. Speaks the catalog HTTP shape as a client.
3. Implements the `WalletAdapter` lifecycle in the order specified.
4. Produces receipts conforming to the receipt schema.
5. Sync-flushes receipts before returning paid call results to callers.

A conformant **catalog server**:

1. Serves the three required HTTP routes.
2. Returns `ListResponse` and `ToolDescriptor` JSON conforming to the schemas above.
3. Honors `ETag` / `If-None-Match` and the `Cache-Control` directives specified.

A conformant **signer** or **protocol** plugin satisfies the respective interface and has a stable `id`.
