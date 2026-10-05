import { nowIso } from '@agon/spec';
import type { Logger } from 'pino';
import type { WebhookEnvelope, WebhookEvent } from './schemas.js';

export type FetchLike = typeof globalThis.fetch;

/** Sends `{ event, timestamp, data }` to the configured URL. Never throws; failures are logged. */
export interface WebhookEmitter {
  readonly enabled: boolean;
  emit(event: WebhookEvent, data: Record<string, unknown>): Promise<void>;
}

export interface WebhookEmitterOptions {
  url: string | undefined;
  logger: Logger;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

export function createWebhookEmitter(options: WebhookEmitterOptions): WebhookEmitter {
  const { url, logger } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  if (!url) {
    return { enabled: false, emit: async () => undefined };
  }
  return {
    enabled: true,
    async emit(event, data) {
      const body: WebhookEnvelope = { event, timestamp: nowIso(), data };
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agon-event': event },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          logger.warn({ event, status: response.status, url }, 'webhook delivery rejected');
        } else {
          logger.debug({ event, url }, 'webhook delivered');
        }
      } catch (error) {
        logger.warn({ err: error, event, url }, 'webhook delivery failed');
      }
    },
  };
}
