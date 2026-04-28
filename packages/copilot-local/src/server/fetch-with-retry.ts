/**
 * fetchWithRetry — generic HTTP retry with exponential backoff.
 *
 * Vendored from `paperclipai/paperclip#3629` (HearthCore) into this package
 * because the helper has not yet shipped in published `@paperclipai/adapter-utils`
 * (latest stable is `2026.427.0`; the helper lives only on the PR branch).
 * Once it lands upstream, replace this file with a re-export from
 * `@paperclipai/adapter-utils/server-utils`.
 *
 * Adapters that call external HTTP APIs (e.g. Copilot's `/copilot_internal/user`,
 * `/models`) should use this instead of bare `fetch()` to handle transient
 * rate-limit and server errors gracefully.
 */

/**
 * Options for `fetchWithRetry`.
 */
export interface FetchRetryOptions {
  /** Maximum number of retry attempts (default: 3). 0 = no retries. */
  maxRetries?: number;
  /** Base delay in ms before first retry — doubles each attempt (default: 2000). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000). */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry (default: [429, 502, 503, 504]).
   *  403 is NOT included by default — pass it explicitly for APIs like Copilot
   *  that use 403 for TPM rate limits.  */
  retryableStatuses?: number[];
  /** Optional callback for retry logging. Called before each retry wait. */
  onRetry?: (info: {
    attempt: number;
    maxRetries: number;
    status: number;
    delayMs: number;
    retryAfterHeader?: string | null;
  }) => void | Promise<void>;
  /** Request timeout in ms per attempt (default: no timeout). */
  timeoutMs?: number;
}

const DEFAULT_RETRYABLE_STATUSES = [429, 502, 503, 504];

/**
 * Fetch with automatic retry on rate-limit / transient server errors.
 *
 * - Respects `Retry-After` header (seconds or HTTP-date) when present.
 * - Falls back to exponential backoff: baseDelay * 2^attempt, capped at maxDelay.
 * - Returns the final Response (successful or last failed attempt).
 * - Throws only on network/abort errors, never on HTTP status codes.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 2000,
    maxDelayMs = 30_000,
    retryableStatuses = DEFAULT_RETRYABLE_STATUSES,
    onRetry,
    timeoutMs,
  } = options;

  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs && timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller!.abort(), timeoutMs);
    }

    // Combine per-attempt timeout signal with any caller-provided signal
    // so external cancellation (e.g. request teardown) is always respected.
    const signals: AbortSignal[] = [];
    if (controller?.signal) signals.push(controller.signal);
    if (init.signal) signals.push(init.signal as AbortSignal);
    const signal =
      signals.length > 1
        ? AbortSignal.any(signals)
        : signals[0] ?? undefined;

    try {
      lastResponse = await fetch(url, { ...init, signal });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (lastResponse.ok) return lastResponse;

    if (!retryableStatuses.includes(lastResponse.status) || attempt >= maxRetries) {
      return lastResponse;
    }

    const retryAfter = lastResponse.headers.get("retry-after");
    let delayMs = baseDelayMs * Math.pow(2, attempt);

    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (!Number.isNaN(parsed) && parsed > 0) {
        delayMs = parsed * 1000;
      } else {
        const date = new Date(retryAfter).getTime();
        if (!Number.isNaN(date)) {
          delayMs = Math.max(0, date - Date.now());
        }
      }
    }

    delayMs = Math.min(delayMs, maxDelayMs);

    // Drain the response body to free the connection
    try { await lastResponse.text(); } catch { /* ignore */ }

    if (onRetry) {
      await onRetry({
        attempt: attempt + 1,
        maxRetries,
        status: lastResponse.status,
        delayMs,
        retryAfterHeader: retryAfter,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return lastResponse!;
}
