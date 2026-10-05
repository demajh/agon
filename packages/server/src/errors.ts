import { AgonError, ErrorCodes, ValidationError, isAgonError } from '@agon/spec';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import { ZodError, z } from 'zod';

/** The JSON envelope every error response carries: `{ error: { code, message, details? } }`. */
export type ErrorBody = ReturnType<AgonError['toJSON']>;

export function zodIssues(error: ZodError): { path: string; message: string; code: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/** Turns a failed request validation into the API's `validation_error`. */
export function validationError(target: string, error: ZodError): ValidationError {
  return new ValidationError(`invalid request ${target}:\n${z.prettifyError(error)}`, {
    target,
    issues: zodIssues(error),
  });
}

/** Maps anything thrown to an `AgonError`; unknown errors become `internal_error`. */
export function toAgonError(error: unknown): AgonError {
  if (isAgonError(error)) return error;
  if (error instanceof HTTPException) {
    const code =
      error.status === 401
        ? ErrorCodes.UNAUTHORIZED
        : error.status === 403
          ? ErrorCodes.FORBIDDEN
          : error.status === 404
            ? ErrorCodes.NOT_FOUND
            : error.status >= 500
              ? ErrorCodes.INTERNAL
              : ErrorCodes.VALIDATION;
    return new AgonError(code, error.message || `HTTP ${error.status}`, {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof ZodError) return validationError('body', error);
  return new AgonError(ErrorCodes.INTERNAL, 'internal error', { status: 500, cause: error });
}

function status(error: AgonError): ContentfulStatusCode {
  const s = error.status;
  return (s >= 400 && s <= 599 ? s : 500) as ContentfulStatusCode;
}

export function errorResponse(c: Context, error: AgonError): Response {
  const body: ErrorBody =
    error.code === ErrorCodes.INTERNAL
      ? { error: { code: error.code, message: 'internal error' } }
      : error.toJSON();
  return c.json(body, status(error));
}

/** Hono error handler: AgonErrors keep their status and code; everything else is a logged 500. */
export function createErrorHandler(logger: Logger): ErrorHandler {
  return (error, c) => {
    const agonError = toAgonError(error);
    if (agonError.code === ErrorCodes.INTERNAL) {
      logger.error(
        { err: error, method: c.req.method, path: c.req.path },
        'unhandled error in request',
      );
    } else {
      logger.debug(
        { code: agonError.code, status: agonError.status, method: c.req.method, path: c.req.path },
        agonError.message,
      );
    }
    return errorResponse(c, agonError);
  };
}

export const notFoundHandler: NotFoundHandler = (c) =>
  c.json(
    {
      error: {
        code: ErrorCodes.NOT_FOUND,
        message: `no route for ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  );
