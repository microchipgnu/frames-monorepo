// TypeScript types matching pay/SPEC.md v0.0.1.
// SPEC is authoritative. Types here are the in-memory representation.

// ---------------------------------------------------------------------------
// Tool descriptor — the unit a catalog returns and a wallet consumes.
// Content-addressed by sha256(jcs(descriptor)).
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  pay_protocol: string;
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  invocation: ToolInvocation;
  payment: ToolPayment;
  schemas?: Record<string, unknown>;
  // SPEC: "Unknown fields must be preserved when forwarded and ignored when
  // not understood." We keep the whole object; this allows _meta and other
  // out-of-band fields to flow through.
  [k: string]: unknown;
}

export interface ToolInvocation {
  method: string; // "GET" | "POST" | "PUT" | …
  url: string;
  params_schema?: unknown; // JSON Schema
}

export interface ToolPayment {
  /**
   * Wire-format protocol the seller speaks. v0.0.1 supports:
   *   - "x402"     — x402 v1 (EIP-3009 EVM, SPL Solana, etc.)
   *   - "x402v2"   — x402 v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers)
   *   - "mpp"      — Machine Payments Protocol (Authorization: Payment + WWW-Authenticate)
   *   - "none"     — free; no payment, but routed through pay for audit + lock parity
   *   - "byok"     — bring-your-own-key: forwards an env-var auth header, amount logged as 0
   * SPEC v0.0.1 requires "x402"; the rest are optional in conformance terms.
   */
  protocol: "x402" | "x402v2" | "mpp" | "none" | "byok" | string;
  network?: string;
  currency?: string;
  /** Hint for budget pre-flight; the seller's 402 challenge is authoritative. */
  price_hint?: string;
  /** Optional: faremeter facilitator URL. Defaults to faremeter's hosted facilitator. */
  facilitator?: string;
  /** byok: env var name to read for the Authorization header. */
  byok_env?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Catalog HTTP shape (catalog server responses)
// ---------------------------------------------------------------------------

export interface CatalogListResponse {
  pay_protocol: string;
  tools: ToolDescriptor[];
  cursor?: string | null;
}

export interface CatalogShowResponse {
  pay_protocol: string;
  tool: ToolDescriptor;
  descriptor_id: string;
}

// ---------------------------------------------------------------------------
// Manifest + Lock (npm-shaped)
// ---------------------------------------------------------------------------

export interface Manifest {
  pay_protocol: string;
  tools: Record<string, ManifestEntry>;
}

/** A tools.yml entry. Either url or path is required. */
export type ManifestEntry =
  | { url: string; integrity?: string; path?: never }
  | { path: string; integrity?: string; url?: never };

export interface Lockfile {
  pay_protocol: string;
  lockfile_version: 1;
  resolved: Record<string, LockEntry>;
}

export interface LockEntry {
  source: { url?: string; path?: string };
  descriptor_id: string;
  fetched_at: string; // ISO 8601
  descriptor: ToolDescriptor;
}

// ---------------------------------------------------------------------------
// Receipt — append-only proof of a paid (or free) call.
// Inlined into events.ndjson under tool.invoked when frame-integrated.
// Signed Ed25519 by a per-machine audit key.
// ---------------------------------------------------------------------------

export interface Receipt {
  pay_protocol: string;
  id: string;
  ts: string; // ISO 8601
  tool_local_name?: string;
  tool_id: string;
  descriptor_id: string;
  params_hash: string; // sha256(jcs(params))
  protocol: string;
  wallet_id: string; // "<faremeter-package>:<user-label>" e.g. "ows:my-base-wallet"
  wallet_address: string;
  amount: string;
  currency: string;
  network: string;
  facilitator_url?: string;
  tx_hash?: string;
  request_hash?: string;
  response_hash?: string;
  agent: string; // "<kind>:<identifier>" e.g. "claude:opus-4.7"
  signature: string; // ed25519:base64url
}

// ---------------------------------------------------------------------------
// Frame integration — events.ndjson event type
// ---------------------------------------------------------------------------

export interface ToolInvokedEvent {
  id: string;
  ts: string;
  type: "tool.invoked";
  agent: string;
  payload: { receipt: Receipt };
}

// ---------------------------------------------------------------------------
// WalletAdapter contract — what the library's main entry point accepts/returns
// ---------------------------------------------------------------------------

export interface PayForToolInput {
  /** Local manifest name, descriptor URL, or descriptor_id. */
  name: string;
  params: unknown;
  /** Defaults to discovered tools.yml in cwd. */
  manifest?: Manifest;
  /** Defaults to discovered tools.lock in cwd. */
  lock?: Lockfile;
  /** Fallback when name isn't in manifest/lock. */
  catalog?: CatalogSource;
}

export interface PayForToolResult {
  body: unknown;
  receipt: Receipt;
}

// ---------------------------------------------------------------------------
// CatalogSource interface
// ---------------------------------------------------------------------------

export interface CatalogSource {
  id: string;
  list(filter?: {
    capability?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ tools: ToolDescriptor[]; cursor?: string | null }>;
  get(toolId: string): Promise<ToolDescriptor | null>;
}

// ---------------------------------------------------------------------------
// Storage interfaces (defaults: MemoryStore + FilesystemStore in stores/)
// ---------------------------------------------------------------------------

export interface WalletStateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
