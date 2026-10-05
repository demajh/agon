import { ConflictError, NotFoundError, ValidationError } from '@agon/spec';
import { DatabaseError } from 'pg';

/** SQLSTATE codes this package translates. */
export const PG_ERROR_CODES = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  notNullViolation: '23502',
  checkViolation: '23514',
  duplicateDatabase: '42P04',
} as const;

/** The fields of a Postgres error this package reads. */
export interface PgErrorFields {
  message: string;
  code?: string | undefined;
  detail?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  column?: string | undefined;
}

function looksLikePgError(error: Error): error is Error & PgErrorFields {
  if (!('severity' in error)) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** Finds the Postgres error inside whatever drizzle wrapped it in (`DrizzleQueryError.cause`). */
export function findPgError(error: unknown): (Error & PgErrorFields) | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof DatabaseError || looksLikePgError(current)) return current;
    current = current.cause;
  }
  return undefined;
}

export function isPgError(error: unknown, code?: string): boolean {
  const found = findPgError(error);
  return found !== undefined && (code === undefined || found.code === code);
}

const FK_MISSING_RE =
  /^Key \((?<columns>[^)]+)\)=\((?<values>.*)\) is not present in table "(?<table>[^"]+)"\.?$/;

function singular(table: string): string {
  return table.endsWith('s') ? table.slice(0, -1) : table;
}

/**
 * Maps a Postgres error to the `AgonError` the API should surface: unique violations become
 * `ConflictError`, dangling references `NotFoundError`, constraint failures `ValidationError`.
 * Anything else is returned unchanged.
 */
export function translateDbError(error: unknown): unknown {
  const pgError = findPgError(error);
  if (!pgError) return error;
  const details = {
    code: pgError.code,
    constraint: pgError.constraint,
    table: pgError.table,
    detail: pgError.detail,
  };
  const suffix = pgError.detail ? `: ${pgError.detail}` : '';
  switch (pgError.code) {
    case PG_ERROR_CODES.uniqueViolation:
      return new ConflictError(`${pgError.table ?? 'row'} already exists${suffix}`, details);
    case PG_ERROR_CODES.foreignKeyViolation: {
      const missing = FK_MISSING_RE.exec(pgError.detail ?? '')?.groups;
      if (missing) {
        return new NotFoundError(singular(missing['table'] ?? 'row'), missing['values'] ?? '');
      }
      return new ConflictError(`${pgError.table ?? 'row'} is still referenced${suffix}`, details);
    }
    case PG_ERROR_CODES.notNullViolation:
    case PG_ERROR_CODES.checkViolation:
      return new ValidationError(pgError.message, details);
    default:
      return error;
  }
}

/** Runs a database operation, translating Postgres errors with `translateDbError`. */
export async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw translateDbError(error);
  }
}
