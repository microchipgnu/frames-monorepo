// Exponential-backoff retry for transient HTTP failures.
//
// Used by FrameClient (frames-cloud) and CatalogClient (catalog.frames.ag) —
// both are read-side, idempotent, and worth retrying on 5xx / network errors.
// NOT used by the paid refetcher: x402 / MPP have their own retry semantics
// inside `wrap()` and double-retry would risk double-charging.

export interface RetryOptions {
  /** Number of retry attempts after the initial. Default 2. */
  retries?: number;
  /** Initial delay in ms; doubles after each attempt. Default 100. */
  initial_delay_ms?: number;
  /** Predicate — return true to retry, false to fail-fast. Default: retry 5xx + network errors. */
  should_retry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Wrap a fetch-shaped operation with retry. The operation is called up to
 * `retries + 1` times. Default retry policy:
 *   - Network errors (TypeError from fetch) → retry
 *   - Response with status >= 500 → retry (caller should throw on !res.ok)
 *   - Anything else → fail-fast
 */
export async function retry<T>(op: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = (opts.retries ?? 2) + 1;
  const shouldRetry = opts.should_retry ?? defaultShouldRetry;
  let delay = opts.initial_delay_ms ?? 100;
  let lastErr: unknown;

  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      if (attempt === max - 1 || !shouldRetry(e, attempt)) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw lastErr;
}

function defaultShouldRetry(err: unknown, _attempt: number): boolean {
  if (err instanceof TypeError) return true; // network / fetch error
  // HttpError-like objects with status field
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    return typeof status === "number" && status >= 500;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
