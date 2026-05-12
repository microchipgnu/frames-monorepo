// Library entry — consumers who want to embed tick programmatically (rather
// than via the CLI or HTTP) import from here. Keep the surface small: just the
// op entry points and the shared types. The Hono app, D1 helpers, and wallet
// boot are internal.

export { curate, type CurateOptions } from "./ops/curate";
export { discover, type DiscoverOptions } from "./ops/discover";
export { verify, type VerifyOptions } from "./ops/verify";
export { refresh, type RefreshOptions } from "./ops/refresh";

export type { Drift, OpOutcome, Refetcher, RefetchResult, ToolDispatchResult } from "./ops/types";

export { FrameClient, FrameClientError } from "./frame-client";
export type { FrameMeta, FrameSchema } from "./frame-client";
export { CatalogClient } from "./catalog/client";
export { LlmClient } from "./llm/client";
export type { LlmContent, LlmMessage, LlmResponse, LlmToolSpec, LlmUsage } from "./llm/client";

export { verifyInboundX402, settleX402, decodePaymentPayload } from "./payment/x402";
export type { X402VerifyResult, X402SettleResult } from "./payment/x402";
export type {
  PaymentRequirements,
  PaymentPayload,
  PaymentRequiredResponse,
  FacilitatorVerifyResponse,
  FacilitatorSettleResponse,
} from "./payment/types";
export { buildPaymentRequirements, usdcToSmallestUnit } from "./payment/payment-requirements";
export { signReceipt, getAuditSigner, canonical } from "./payment/audit-signer";

// Re-export the wire types so consumers only need one import:
export type { Op, RunInput, RunResult, FrameEvent, ToolCall } from "@frames-ag/tick-types";
