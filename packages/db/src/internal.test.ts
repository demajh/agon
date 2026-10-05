import { AgonError, RunSchema, ValidationError } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  TimeIdCursorSchema,
  chunk,
  clampLimit,
  compact,
  decodeCursor,
  encodeCursor,
  parseRow,
  toDate,
  toPage,
} from './internal.js';

describe('cursors', () => {
  it('round-trip through an opaque string', () => {
    const cursor = { t: '2026-10-04T17:00:00.000Z', i: 'run_abc' };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, TimeIdCursorSchema)).toEqual(cursor);
  });

  it('reject garbage and wrong shapes as validation errors', () => {
    expect(() => decodeCursor('!!!', TimeIdCursorSchema)).toThrow(ValidationError);
    expect(() => decodeCursor(encodeCursor({ nope: 1 }), TimeIdCursorSchema)).toThrow(
      ValidationError,
    );
  });

  it('toPage returns a cursor only when a row beyond the limit was fetched', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const full = toPage(rows, 2, (last) => ({ i: last.id }));
    expect(full.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(full.nextCursor).toBe(encodeCursor({ i: 'b' }));
    expect(toPage(rows, 3, (last) => ({ i: last.id }))).toEqual({ items: rows });
    expect(toPage([], 3, (last) => last)).toEqual({ items: [] });
  });
});

describe('clampLimit', () => {
  const bounds = { default: 50, max: 200 };
  it('defaults, clamps and validates', () => {
    expect(clampLimit(undefined, bounds)).toBe(50);
    expect(clampLimit(10, bounds)).toBe(10);
    expect(clampLimit(10_000, bounds)).toBe(200);
    expect(() => clampLimit(0, bounds)).toThrow(ValidationError);
    expect(() => clampLimit(1.5, bounds)).toThrow(ValidationError);
  });
});

describe('row helpers', () => {
  it('compact drops undefined values but keeps null and falsy ones', () => {
    expect(compact({ a: undefined, b: null, c: 0, d: '' })).toEqual({ b: null, c: 0, d: '' });
  });

  it('chunk splits evenly and keeps the remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it('toDate rejects unparsable timestamps', () => {
    expect(toDate('2026-10-04T17:00:00.000Z').toISOString()).toBe('2026-10-04T17:00:00.000Z');
    expect(() => toDate('yesterday')).toThrow(ValidationError);
  });

  it('parseRow reports corrupt rows as internal errors naming the row', () => {
    expect(() => parseRow(RunSchema, { id: 'run_x' }, 'run', 'run_x')).toThrow(AgonError);
    try {
      parseRow(RunSchema, { id: 'run_x' }, 'run', 'run_x');
    } catch (error) {
      expect(error).toBeInstanceOf(AgonError);
      expect((error as AgonError).code).toBe('internal_error');
      expect((error as AgonError).message).toContain('run run_x is corrupt');
    }
  });
});
