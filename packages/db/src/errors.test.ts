import { ConflictError, NotFoundError, ValidationError } from '@agon/spec';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { findPgError, isPgError, translateDbError } from './errors.js';

function pgError(code: string, fields: { detail?: string; table?: string; constraint?: string }) {
  const error = new DatabaseError(`sqlstate ${code}`, 0, 'error');
  error.code = code;
  error.detail = fields.detail;
  error.table = fields.table;
  error.constraint = fields.constraint;
  return error;
}

describe('translateDbError', () => {
  it('finds the Postgres error inside drizzle wrappers', () => {
    const inner = pgError('23505', { table: 'squads' });
    const wrapped = new DrizzleQueryError('insert into squads ...', [], inner);
    expect(findPgError(wrapped)).toBe(inner);
    expect(isPgError(wrapped, '23505')).toBe(true);
    expect(isPgError(wrapped, '23503')).toBe(false);
    expect(isPgError(new Error('nope'))).toBe(false);
  });

  it('maps unique violations to ConflictError', () => {
    const error = translateDbError(
      pgError('23505', {
        table: 'squads',
        constraint: 'squads_slug_key',
        detail: 'Key (slug)=(blue) already exists.',
      }),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toBe(
      'squads already exists: Key (slug)=(blue) already exists.',
    );
    expect((error as ConflictError).details).toMatchObject({ constraint: 'squads_slug_key' });
  });

  it('maps dangling references to NotFoundError for the referenced row', () => {
    const error = translateDbError(
      pgError('23503', {
        table: 'runs',
        detail: 'Key (environment_id)=(env_missing) is not present in table "environments".',
      }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('environment not found: env_missing');
  });

  it('maps blocked deletes to ConflictError', () => {
    const error = translateDbError(
      pgError('23503', {
        table: 'squads',
        detail: 'Key (id)=(sqd_1) is still referenced from table "api_keys".',
      }),
    );
    expect(error).toBeInstanceOf(ConflictError);
  });

  it('maps not-null and check violations to ValidationError', () => {
    expect(translateDbError(pgError('23502', {}))).toBeInstanceOf(ValidationError);
    expect(translateDbError(pgError('23514', {}))).toBeInstanceOf(ValidationError);
  });

  it('returns anything else unchanged', () => {
    const plain = new Error('boom');
    expect(translateDbError(plain)).toBe(plain);
    const other = pgError('42P01', {});
    expect(translateDbError(other)).toBe(other);
    expect(translateDbError('string')).toBe('string');
  });
});
