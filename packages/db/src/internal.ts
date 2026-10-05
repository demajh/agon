import { AgonError, ErrorCodes, ValidationError } from '@agon/spec';
import { z } from 'zod';
import type { Page } from './types.js';

/**
 * Validates a row against its spec schema before handing it out, so corrupt data fails loudly
 * instead of propagating. Throws an `internal_error` naming the row.
 */
export function parseRow<T>(schema: z.ZodType<T>, value: unknown, resource: string, id: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AgonError(
      ErrorCodes.INTERNAL,
      `${resource} ${id} is corrupt in the database:\n${z.prettifyError(parsed.error)}`,
      { details: { resource, id, issues: parsed.error.issues } },
    );
  }
  return parsed.data;
}

/** The single row a statement with RETURNING must produce. */
export function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new AgonError(ErrorCodes.INTERNAL, `expected ${what} to return a row`);
  }
  return row;
}

/** Splits rows into insert batches so one statement never carries too many parameters. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Drops keys whose value is `undefined`, so optional spec fields stay absent rather than null-ish. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function toIsoOrUndefined(date: Date | null | undefined): string | undefined {
  return date == null ? undefined : date.toISOString();
}

export function toDate(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`invalid timestamp: ${iso}`);
  return date;
}

export function toDateOrNull(iso: string | null | undefined): Date | null {
  return iso == null ? null : toDate(iso);
}

export interface LimitBounds {
  default: number;
  max: number;
}

export function clampLimit(limit: number | undefined, bounds: LimitBounds): number {
  if (limit === undefined) return bounds.default;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`limit must be a positive integer, got ${limit}`);
  }
  return Math.min(limit, bounds.max);
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid cursor');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('invalid cursor', parsed.error.issues);
  return parsed.data;
}

/** Keyset cursor over (timestamp, id). */
export const TimeIdCursorSchema = z.object({ t: z.iso.datetime({ offset: true }), i: z.string() });
export type TimeIdCursor = z.infer<typeof TimeIdCursorSchema>;

/** Keyset cursor over an integer position. */
export const IndexCursorSchema = z.object({ i: z.number().int() });
export type IndexCursor = z.infer<typeof IndexCursorSchema>;

/**
 * Turns `limit + 1` fetched rows into a page: the extra row only signals that more exist, and the
 * cursor is derived from the last row returned.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => unknown): Page<T> {
  const items = rows.length > limit ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  if (rows.length > limit && last !== undefined) {
    return { items, nextCursor: encodeCursor(cursorOf(last)) };
  }
  return { items };
}
