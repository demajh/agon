export const ErrorCodes = {
  VALIDATION: 'validation_error',
  CONFIG: 'config_error',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  BUDGET_EXCEEDED: 'budget_exceeded',
  ADAPTER: 'adapter_error',
  LLM: 'llm_error',
  EXPORT: 'export_error',
  POLICY_BLOCKED: 'policy_blocked',
  INTERNAL: 'internal_error',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AgonErrorOptions {
  status?: number;
  details?: unknown;
  cause?: unknown;
}

/** Base class for every error Agon raises on purpose. `code` is stable and part of the API. */
export class AgonError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AgonErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgonError';
    this.code = code;
    this.status = options.status ?? 500;
    this.details = options.details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class ValidationError extends AgonError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.VALIDATION, message, { status: 400, details });
    this.name = 'ValidationError';
  }
}

export class ConfigError extends AgonError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.CONFIG, message, { status: 400, details });
    this.name = 'ConfigError';
  }
}

export class NotFoundError extends AgonError {
  constructor(resource: string, id: string) {
    super(ErrorCodes.NOT_FOUND, `${resource} not found: ${id}`, {
      status: 404,
      details: { resource, id },
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AgonError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.CONFLICT, message, { status: 409, details });
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends AgonError {
  constructor(message = 'missing or invalid API key') {
    super(ErrorCodes.UNAUTHORIZED, message, { status: 401 });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AgonError {
  constructor(message = 'insufficient role for this operation') {
    super(ErrorCodes.FORBIDDEN, message, { status: 403 });
    this.name = 'ForbiddenError';
  }
}

export class BudgetExceededError extends AgonError {
  constructor(what: string, limit: number, actual: number) {
    super(ErrorCodes.BUDGET_EXCEEDED, `${what} budget exceeded: ${actual} > ${limit}`, {
      status: 402,
      details: { what, limit, actual },
    });
    this.name = 'BudgetExceededError';
  }
}

export class AdapterError extends AgonError {
  constructor(message: string, options: AgonErrorOptions = {}) {
    super(ErrorCodes.ADAPTER, message, { status: 502, ...options });
    this.name = 'AdapterError';
  }
}

export class LlmError extends AgonError {
  constructor(message: string, options: AgonErrorOptions = {}) {
    super(ErrorCodes.LLM, message, { status: 502, ...options });
    this.name = 'LlmError';
  }
}

/** A policy gate refused the operation (e.g. a diff touching a protected path without an approval). */
export class PolicyBlockedError extends AgonError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.POLICY_BLOCKED, message, { status: 403, details });
    this.name = 'PolicyBlockedError';
  }
}

export function isAgonError(error: unknown): error is AgonError {
  return error instanceof AgonError;
}
