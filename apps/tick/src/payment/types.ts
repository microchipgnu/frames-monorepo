// Wire types for x402 v2 (https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md).
//
// These match the canonical spec exactly — field names, optionality, casing.
// Both Coinbase CDP and upstream Faremeter v0.21.0+ speak this on the wire.
// Don't rename fields here; offline verifiers and facilitator clients depend
// on the exact shape.

/**
 * What the server tells the client it needs paid (section 5.1.2 of the spec).
 * Returned as `accepts: [PaymentRequirements]` in the 402 response body.
 */
export interface PaymentRequirements {
  /** Payment scheme — typically the asset transfer mechanism (e.g. "erc3009", "spl-token", "exact"). */
  scheme: string;
  /** Network slug (e.g. "base", "solana-mainnet", "tempo"). */
  network: string;
  /** Amount in the asset's smallest unit, as a decimal string. Six decimals for USDC. */
  amount: string;
  /** Asset identifier — usually a token contract address for EVM, mint address for Solana. */
  asset: string;
  /** Operator's receiving wallet. EVM hex or Solana base58. */
  payTo: string;
  /** Max seconds the server will wait for the client to settle. */
  maxTimeoutSeconds: number;
  /** Scheme-specific extensions (e.g. EIP-712 domain hints). */
  extra?: Record<string, unknown>;
}

/**
 * What the client sends back in the PAYMENT-SIGNATURE header on the retry
 * request, base64-encoded (section 5.2.2).
 */
export interface PaymentPayload {
  /** Protocol version. Always 2 for v2. */
  x402Version: number;
  /** Resource the client is paying for. URL string or structured resource ref. */
  resource?: string | Record<string, unknown>;
  /** The PaymentRequirements entry from the server's `accepts` array that the client picked. */
  accepted: PaymentRequirements;
  /** Scheme-specific payment data (signed transfer authorization, etc.). */
  payload: Record<string, unknown>;
  /** Optional client-side extensions. */
  extensions?: Record<string, unknown>;
}

/** The 402 response body (section 5.1.1). */
export interface PaymentRequiredResponse {
  x402Version: number;
  error?: string;
  resource: string | Record<string, unknown>;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** Facilitator `/verify` response shape. */
export interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Facilitator `/settle` response shape. */
export interface FacilitatorSettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** On-chain transaction hash (or equivalent network-specific reference). */
  transaction: string;
  network: string;
  amount?: string;
}
