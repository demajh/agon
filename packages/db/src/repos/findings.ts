import { ConflictError, FindingSchema, NotFoundError, newId, nowIso } from '@agon/spec';
import type { ClosedFindingStatus, Finding, FindingStatus, Settlement } from '@agon/spec';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import {
  TimeIdCursorSchema,
  clampLimit,
  compact,
  decodeCursor,
  first,
  parseRow,
  toDate,
  toIso,
  toIsoOrUndefined,
  toPage,
} from '../internal.js';
import { findings } from '../schema.js';
import type { FindingRow } from '../schema.js';
import type { Page, PageOptions } from '../types.js';

const LIMITS = { default: 50, max: 500 };

/** A new finding is always open; it is closed later, never edited. */
export interface InsertFindingInput {
  id?: string;
  receiptId: string;
  invariant: string;
  impact: string;
  closureOwner: string;
  settlement: Settlement;
  requirementsDigest?: string;
  createdAt?: string;
}

export interface ListFindingsOptions extends PageOptions {
  receiptId?: string;
  status?: FindingStatus;
}

export function toFinding(row: FindingRow): Finding {
  return parseRow(
    FindingSchema,
    compact({
      id: row.id,
      receiptId: row.receiptId,
      invariant: row.invariant,
      impact: row.impact,
      closureOwner: row.closureOwner,
      status: row.status,
      settlement: row.settlement,
      requirementsDigest: row.requirementsDigest ?? undefined,
      createdAt: toIso(row.createdAt),
      closedAt: toIsoOrUndefined(row.closedAt),
    }),
    'finding',
    row.id,
  );
}

/** Files a finding against a receipt (a result id). */
export async function insert(db: Db, input: InsertFindingInput): Promise<Finding> {
  const finding = FindingSchema.parse({
    id: input.id ?? newId('fnd'),
    receiptId: input.receiptId,
    invariant: input.invariant,
    impact: input.impact,
    closureOwner: input.closureOwner,
    status: 'open',
    settlement: input.settlement,
    requirementsDigest: input.requirementsDigest,
    createdAt: input.createdAt ?? nowIso(),
  });
  const rows = await guard(() =>
    db
      .insert(findings)
      .values({
        id: finding.id,
        receiptId: finding.receiptId,
        invariant: finding.invariant,
        impact: finding.impact,
        closureOwner: finding.closureOwner,
        status: finding.status,
        settlement: finding.settlement,
        requirementsDigest: finding.requirementsDigest ?? null,
        createdAt: toDate(finding.createdAt),
      })
      .returning(),
  );
  return toFinding(first(rows, 'insert finding'));
}

export async function find(db: Db, id: string): Promise<Finding | undefined> {
  const rows = await db.select().from(findings).where(eq(findings.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toFinding(row);
}

export async function get(db: Db, id: string): Promise<Finding> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('finding', id);
  return found;
}

/** Newest first. */
export async function list(db: Db, options: ListFindingsOptions = {}): Promise<Page<Finding>> {
  const limit = clampLimit(options.limit, LIMITS);
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, TimeIdCursorSchema);
  const rows = await db
    .select()
    .from(findings)
    .where(
      and(
        options.receiptId === undefined ? undefined : eq(findings.receiptId, options.receiptId),
        options.status === undefined ? undefined : eq(findings.status, options.status),
        cursor === undefined
          ? undefined
          : or(
              lt(findings.createdAt, toDate(cursor.t)),
              and(eq(findings.createdAt, toDate(cursor.t)), lt(findings.id, cursor.i)),
            ),
      ),
    )
    .orderBy(desc(findings.createdAt), desc(findings.id))
    .limit(limit + 1);
  return toPage(rows.map(toFinding), limit, (last) => ({ t: last.createdAt, i: last.id }));
}

/**
 * Closes an open finding as fixed or tolerated. Only an open finding can be closed, and only once:
 * the update is conditional on `status = 'open'`, so two concurrent closes cannot both win.
 */
export async function close(
  db: Db,
  id: string,
  status: ClosedFindingStatus,
  closedAt: string = nowIso(),
): Promise<Finding> {
  const rows = await guard(() =>
    db
      .update(findings)
      .set({ status, closedAt: toDate(closedAt) })
      .where(and(eq(findings.id, id), eq(findings.status, 'open')))
      .returning(),
  );
  const row = rows[0];
  if (row !== undefined) return toFinding(row);
  const existing = await get(db, id);
  throw new ConflictError(`finding ${id} is already ${existing.status}`);
}
