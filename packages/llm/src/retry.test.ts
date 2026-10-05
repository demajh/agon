import { APICallError, RetryError } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { isRetryableLlmError, retryDelayMs, withRetry } from './retry.js';

function apiError(
  statusCode: number | undefined,
  extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {},
) {
  return new APICallError({
    message: `status ${statusCode}`,
    url: 'https://api.example.test/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === undefined ? false : statusCode === 429 || statusCode >= 500,
    ...extra,
  });
}

describe('isRetryableLlmError', () => {
  it('retries rate limits, server errors, timeouts and network failures', () => {
    expect(isRetryableLlmError(apiError(429))).toBe(true);
    expect(isRetryableLlmError(apiError(500))).toBe(true);
    expect(isRetryableLlmError(apiError(503, { isRetryable: false }))).toBe(true);
    expect(isRetryableLlmError(apiError(408, { isRetryable: false }))).toBe(true);
    expect(
      isRetryableLlmError(
        apiError(undefined, { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
      ),
    ).toBe(true);
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isRetryableLlmError(Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })),
    ).toBe(true);
    expect(
      isRetryableLlmError(
        new RetryError({
          message: 'gave up',
          reason: 'maxRetriesExceeded',
          errors: [apiError(502)],
        }),
      ),
    ).toBe(true);
  });

  it('does not retry client errors, aborts, schema failures or unknown errors', () => {
    expect(isRetryableLlmError(apiError(400))).toBe(false);
    expect(isRetryableLlmError(apiError(401))).toBe(false);
    expect(isRetryableLlmError(apiError(404))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(
      false,
    );
    expect(isRetryableLlmError(new Error('boom'))).toBe(false);
    expect(isRetryableLlmError('nope')).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
    expect(
      isRetryableLlmError(
        new RetryError({
          message: 'not retryable',
          reason: 'errorNotRetryable',
          errors: [apiError(400)],
        }),
      ),
    ).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially from the base delay and caps at the maximum', () => {
    const error = new Error('x');
    expect(retryDelayMs(error, 1, 100)).toBe(100);
    expect(retryDelayMs(error, 2, 100)).toBe(200);
    expect(retryDelayMs(error, 3, 100)).toBe(400);
    expect(retryDelayMs(error, 10, 100, 1_000)).toBe(1_000);
  });

  it('honours retry-after hints under a minute', () => {
    expect(retryDelayMs(apiError(429, { responseHeaders: { 'retry-after': '2' } }), 1, 100)).toBe(
      2_000,
    );
    expect(
      retryDelayMs(apiError(429, { responseHeaders: { 'retry-after-ms': '250' } }), 1, 100),
    ).toBe(250);
    expect(retryDelayMs(apiError(429, { responseHeaders: { 'retry-after': '120' } }), 1, 100)).toBe(
      100,
    );
  });
});

describe('withRetry', () => {
  it('retries retryable failures with increasing delays, then returns the result', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue('ok');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 10, sleep, onRetry })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, retries: 3, delayMs: 10 });
  });

  it('gives up after the configured retries and rethrows the last error', async () => {
    const last = apiError(500);
    const fn = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(apiError(502))
      .mockRejectedValue(last);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1, sleep })).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-retryable errors immediately', async () => {
    const error = apiError(400);
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1, sleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('disables retrying when retries is 0', async () => {
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(apiError(429));
    await expect(withRetry(fn, { retries: 0, baseDelayMs: 1 })).rejects.toBeInstanceOf(
      APICallError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
