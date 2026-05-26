// Typed errors for `pay_tool` callers.
//
// Today the dispatch layer throws into several distinct shapes — DispatchError,
// InsufficientBalanceError, BridgeError, BalanceError — and the MCP handler
// just lets them propagate raw, so callers see opaque strings like
// "agentwallet 500: ..." and "no viable wallet across N options: ...".
//
// This module classifies what gets thrown into a small, stable enum that
// programs can branch on (matching the OpenProse `Errors` clauses on
// discover.md / curate.md: WalletNotReady, BudgetExceeded, NoCatalogTool).
//
// Verified 2026-05-25 against the layoffs-2026 discover run: three paid
// attempts each returned "agentwallet 500" with no way for the agent to
// distinguish "wallet is empty" from "service is down" from "seller doesn't
// accept this rail." Classification here makes that distinction available
// without a 200-line shell-out diagnostic.

import { DispatchError, InsufficientBalanceError } from "./wallet/dispatch.ts";
import { BalanceError } from "./wallet/balance.ts";

export type PayErrorKind =
  /** Wallet exists for the required network but balance < seller's price. */
  | "insufficient_funds"
  /** No wallet is configured for any network the descriptor advertises. */
  | "network_unconfigured"
  /** Agentwallet returned a non-2xx HTTP response, or its network was unreachable. */
  | "agentwallet_unreachable"
  /** Seller (either direct or via agentwallet) returned a non-2xx response. */
  | "seller_rejected"
  /** Locked descriptor diverges from live catalog (PR A #3; not yet emitted). */
  | "descriptor_mismatch"
  /** Bridge / handler could not construct a signed call for this rail. */
  | "wallet_signing_error"
  /** Balance probe failed (RPC unreachable, unknown asset, etc.). */
  | "balance_check_failed"
  /** Everything else — preserves original message for triage. */
  | "unknown";

export interface PayError {
  kind: PayErrorKind;
  /** One-line human-readable summary; safe to surface in agent traces. */
  message: string;
  /**
   * Hint for callers: would a literal retry (same args, same wallet, same
   * lock) plausibly succeed? Service outages → true. Insufficient funds →
   * false until topped up. Network unconfigured → false until config changes.
   */
  retryable: boolean;
  /** Structured payload for callers that want to branch on details. */
  details?: Record<string, unknown>;
  /** Original error.message — kept for debugging when the classifier had to guess. */
  cause?: string;
}

/**
 * Classify a thrown error from `payForTool` into a stable PayError shape.
 *
 * Lossy by design — multiple raw messages map to one kind, but the original
 * is preserved in `cause`. Callers branch on `kind`; humans read `message`
 * and (when triaging) `cause`.
 */
export function classifyPayError(err: unknown): PayError {
  if (err instanceof InsufficientBalanceError) {
    return {
      kind: "insufficient_funds",
      message: `wallet has ${err.balance} ${err.currency} on ${err.network}; seller requires ${err.required}`,
      retryable: false,
      details: {
        balance: err.balance,
        required: err.required,
        currency: err.currency,
        network: err.network,
      },
      cause: err.message,
    };
  }

  if (err instanceof BalanceError) {
    return {
      kind: "balance_check_failed",
      message: err.message,
      // RPC outages are usually transient.
      retryable: true,
      cause: err.message,
    };
  }

  if (err instanceof DispatchError) {
    const msg = err.message;

    // "no rail succeeded across N payment options: ..." — the aggregated
    // error from payForTool's runtime-fallback loop (PR #17). Classify by
    // what the per-rail runtime failures look like; the runtime-failures
    // tail of the message lists every per-rail attempt.
    if (/^no rail succeeded across/.test(msg)) {
      // Find the first agentwallet-style status code in the runtime tail.
      // If every rail returned the same status, treat them as one signal.
      const railStatuses = [...msg.matchAll(/agentwallet (\d+):/g)].map((m) => Number(m[1]));
      const allAgentwallet = railStatuses.length > 0;
      const status = railStatuses[0];
      if (allAgentwallet) {
        const retryable = status !== undefined && [429, 500, 502, 503, 504].includes(status);
        return {
          kind: "agentwallet_unreachable",
          message: msg,
          retryable,
          details: {
            rail_count: railStatuses.length,
            rail_statuses: railStatuses,
            // Surface a short hint for the agent — what every rail returned.
            ...(status !== undefined && new Set(railStatuses).size === 1 && {
              uniform_status: status,
            }),
          },
          cause: msg,
        };
      }
      // Mixed runtime failures — leave as unknown but preserve full message.
      return {
        kind: "unknown",
        message: msg,
        retryable: false,
        cause: msg,
      };
    }

    // "no viable wallet across N payment option(s): ..."
    // Inspect the summary to refine the classification. The dispatch summary
    // string is the structured truth — these checks mirror the per-attempt
    // status codes in dispatch.ts (no_handler / insufficient_balance /
    // no_wallet_for_network / balance_check_failed).
    if (/^no viable wallet across/.test(msg)) {
      if (/insufficient_balance/.test(msg)) {
        return {
          kind: "insufficient_funds",
          message: msg,
          retryable: false,
          cause: msg,
        };
      }
      if (/no_handler|no_wallet_for_network/.test(msg)) {
        return {
          kind: "network_unconfigured",
          message: msg,
          retryable: false,
          cause: msg,
        };
      }
      if (/balance_check_failed/.test(msg)) {
        return {
          kind: "balance_check_failed",
          message: msg,
          retryable: true,
          cause: msg,
        };
      }
      return {
        kind: "wallet_signing_error",
        message: msg,
        retryable: false,
        cause: msg,
      };
    }

    // "agentwallet 500: ..." / "agentwallet failed: ..."
    if (/^agentwallet (\d+|failed)/.test(msg)) {
      const status = msg.match(/^agentwallet (\d+)/)?.[1];
      // Retryable when the status is a server-side transient (5xx) or
      // when it's a 429 throttle (the throttle will lift). 4xx other than
      // 429 is a client config issue and should not be retried as-is.
      const retryable = status === undefined || ["429", "500", "502", "503", "504"].includes(status);
      const details: Record<string, unknown> = {};
      if (status !== undefined) details["agentwallet_status"] = Number(status);
      // DispatchError carries the full upstream body. Surface its parsed
      // form so callers see the actual reason agentwallet rejected — not
      // just the truncated prefix in `message`. This is the fix for the
      // "opaque 500" surfaced by the layoffs-2026 discover run on
      // 2026-05-26 where the real error sat just past the old 200-char
      // truncation cliff.
      if (err.body) {
        details["body"] = err.body.parsed ?? err.body.raw;
        details["body_source"] = err.body.source;
      }
      return {
        kind: "agentwallet_unreachable",
        message: msg,
        retryable,
        ...(Object.keys(details).length > 0 && { details }),
        cause: msg,
      };
    }

    // "seller (via agentwallet) returned X: ..." / "seller returned X: ..."
    const sellerMatch = msg.match(/^seller(?: \(via agentwallet\))? returned (\d+)/);
    if (sellerMatch) {
      const status = Number(sellerMatch[1]);
      // 5xx = seller side problem (likely transient). 4xx = client/rail issue (not retryable as-is).
      const retryable = status >= 500;
      const details: Record<string, unknown> = { seller_status: status };
      if (err.body) {
        details["body"] = err.body.parsed ?? err.body.raw;
        details["body_source"] = err.body.source;
      }
      return {
        kind: "seller_rejected",
        message: msg,
        retryable,
        details,
        cause: msg,
      };
    }

    // "delegated provider X not yet supported"
    if (/^delegated provider/.test(msg)) {
      return {
        kind: "wallet_signing_error",
        message: msg,
        retryable: false,
        cause: msg,
      };
    }

    return {
      kind: "unknown",
      message: msg,
      retryable: false,
      cause: msg,
    };
  }

  // Anything else — surface message but flag unknown.
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "unknown",
    message,
    retryable: false,
    cause: message,
  };
}
