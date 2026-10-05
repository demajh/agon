import { APICallError, RetryError } from 'ai';

export interface RetryOptions {
  /** Number of retries after the first attempt; 0 disables retrying. */
  retries: number;
  /** Delay before the first retry; doubles on every further retry. */
  baseDelayMs: number;
  /** Upper bound for the exponential delay (default 30s). */
  maxDelayMs?: number;
  /** Decides whether an error is worth retrying (default `isRetryableLlmError`). */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: unknown }) => void;
}

const DEFAULT_MAX_DELAY_MS = 30_000;

/** Error codes thrown by Node's fetch/undici and the socket layer for transient network trouble. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isNetworkError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object' || depth > 4) return false;
  const code = errorCode(error);
  if (code && NETWORK_ERROR_CODES.has(code)) return true;
  if (error instanceof TypeError && /fetch failed|network|socket hang up/i.test(error.message)) {
    return true;
  }
  return isNetworkError((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * Rate limits (429), server errors (5xx), request timeouts and transport failures are retryable.
 * Other client errors (4xx), aborts and schema failures are not.
 */
export function isRetryableLlmError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return false;
  if (APICallError.isInstance(error)) {
    if (error.isRetryable) return true;
    const status = error.statusCode;
    if (status === undefined) return isNetworkError(error);
    return RETRYABLE_STATUS.has(status) || status >= 500;
  }
  if (RetryError.isInstance(error)) {
    return error.reason === 'maxRetriesExceeded' && isRetryableLlmError(error.lastError);
  }
  return isNetworkError(error);
}

function responseHeaders(error: unknown): Record<string, string> | undefined {
  if (APICallError.isInstance(error)) return error.responseHeaders;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return APICallError.isInstance(cause) ? cause.responseHeaders : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const headers = responseHeaders(error);
  if (!headers) return undefined;
  const ms = headers['retry-after-ms'];
  if (ms !== undefined && !Number.isNaN(Number.parseFloat(ms))) return Number.parseFloat(ms);
  const seconds = headers['retry-after'];
  if (seconds === undefined) return undefined;
  const parsed = Number.parseFloat(seconds);
  if (!Number.isNaN(parsed)) return parsed * 1000;
  const until = Date.parse(seconds) - Date.now();
  return Number.isNaN(until) ? undefined : until;
}

/**
 * Delay before retry number `attempt` (1-based): exponential backoff capped at `maxDelayMs`,
 * replaced by the server's `retry-after` hint when one is present and under a minute.
 */
export function retryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const hinted = retryAfterMs(error);
  if (hinted !== undefined && hinted >= 0 && (hinted < 60_000 || hinted < exponential)) {
    return Math.round(hinted);
  }
  return Math.round(exponential);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn`, retrying retryable failures with exponential backoff. Rethrows the last error. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries));
  const isRetryable = options.isRetryable ?? isRetryableLlmError;
  const sleep = options.sleep ?? defaultSleep;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const delayMs = retryDelayMs(error, attempt + 1, options.baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt: attempt + 1, retries, delayMs, error });
      await sleep(delayMs);
    }
  }
}
