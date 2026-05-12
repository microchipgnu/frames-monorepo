// Standard error response shape for tick's HTTP API.
//
// Every error response from /run, /runs/:id, /history, /balance follows this
// shape. Customers can pattern-match on `code` (string enum) and surface
// `message` to humans. Optional `details` carries op-specific fields.

import type { Context } from "hono";

export type ApiErrorCode =
  // Request validation
  | "invalid_json"
  | "invalid_body"
  | "invalid_op"
  | "invalid_frame"
  | "missing_field"
  // Auth / payment
  | "rate_limited"
  | "missing_llm_auth"
  | "x402_verify_failed"
  | "x402_settle_failed"
  | "agent_not_allowlisted"
  | "invalid_api_key"
  // Resources
  | "not_found"
  | "no_db_binding"
  | "frame_unreachable"
  | "catalog_unreachable"
  // Runtime
  | "internal"
  | "op_failed"
  | "budget_exhausted"
  | "unhandled_op"
  // Idempotency
  | "idempotency_conflict"
  | "address_required";

export interface ApiError {
  error: string;        // human-readable message
  code: ApiErrorCode;   // machine-readable
  /** Optional structured details. Code-specific keys. */
  details?: Record<string, unknown>;
}

/** Build a typed error body. Use `errorResponse()` to wrap with c.json + status. */
export function apiError(code: ApiErrorCode, message: string, details?: Record<string, unknown>): ApiError {
  return details ? { error: message, code, details } : { error: message, code };
}

/** Send an error response with the right HTTP status + JSON body. */
export function errorResponse(
  c: Context,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return c.json(
    apiError(code, message, details),
    status as 400 | 401 | 404 | 409 | 422 | 429 | 500 | 503,
    headers,
  );
}
