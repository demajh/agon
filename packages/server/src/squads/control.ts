import {
  AgonError,
  ErrorCodes,
  SquadControlMessageSchema,
  type SquadControlMessage,
} from '@agon/spec';
import type { Logger } from 'pino';
import type { FetchLike } from '../webhooks.js';

export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

/** Delivers Squad Control Protocol messages to a squad's `controlUrl`. */
export interface ControlSender {
  /** Resolves on a 2xx response; throws an `AgonError` otherwise (timeouts included). */
  send(controlUrl: string, message: SquadControlMessage): Promise<void>;
}

export interface ControlSenderOptions {
  logger: Logger;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}

export class ControlDeliveryError extends AgonError {
  constructor(message: string, details?: unknown, cause?: unknown) {
    super(ErrorCodes.INTERNAL, message, { status: 502, details, cause });
    this.name = 'ControlDeliveryError';
  }
}

export function createControlSender(options: ControlSenderOptions): ControlSender {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  return {
    async send(controlUrl, message) {
      const body = SquadControlMessageSchema.parse(message);
      let response: Response;
      try {
        response = await fetchImpl(controlUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agon-action': body.action },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.logger.warn(
          { err: error, controlUrl, action: body.action, decisionId: body.decisionId },
          'squad control message failed',
        );
        throw new ControlDeliveryError(
          `control webhook ${controlUrl} unreachable: ${reason}`,
          { controlUrl, action: body.action },
          error,
        );
      }
      if (!response.ok) {
        options.logger.warn(
          { controlUrl, status: response.status, action: body.action, decisionId: body.decisionId },
          'squad control message rejected',
        );
        throw new ControlDeliveryError(
          `control webhook ${controlUrl} answered ${response.status}`,
          { controlUrl, action: body.action, status: response.status },
        );
      }
      options.logger.info(
        { controlUrl, action: body.action, decisionId: body.decisionId },
        'squad control message delivered',
      );
    },
  };
}
