import { DecisionSchema, NotFoundError, newId, nowIso } from '@agon/spec';
import type { Decision, DecisionStatus, PolicyAction } from '@agon/spec';
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
import { decisions } from '../schema.js';
import type { DecisionRow } from '../schema.js';
import type { Page, PageOptions } from '../types.js';

const LIMITS = { default: 50, max: 500 };

export interface InsertDecisionInput {
  id?: string;
  kind: PolicyAction;
  /** Defaults to `proposed`. */
  status?: DecisionStatus;
  squadId?: string;
  policyId?: string;
  actor: Decision['actor'];
  rationale: string;
  evidence?: Partial<Decision['evidence']>;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface ListDecisionsOptions extends PageOptions {
  squadId?: string;
  status?: DecisionStatus;
  kind?: PolicyAction;
  policyId?: string;
  actor?: Decision['actor'];
}

export interface SetDecisionStatusOptions {
  /** Defaults to now when the status becomes `approved` or `rejected`. */
  decidedAt?: string;
  /** Defaults to now when the status becomes `executed`. */
  executedAt?: string;
  error?: string;
}

export function toDecision(row: DecisionRow): Decision {
  return parseRow(
    DecisionSchema,
    compact({
      id: row.id,
      kind: row.kind,
      status: row.status,
      squadId: row.squadId ?? undefined,
      policyId: row.policyId ?? undefined,
      actor: row.actor,
      rationale: row.rationale,
      evidence: row.evidence,
      payload: row.payload,
      createdAt: toIso(row.createdAt),
      decidedAt: toIsoOrUndefined(row.decidedAt),
      executedAt: toIsoOrUndefined(row.executedAt),
      error: row.error ?? undefined,
    }),
    'decision',
    row.id,
  );
}

/** Appends a decision. Rows are never deleted; only their status advances. */
export async function insert(db: Db, input: InsertDecisionInput): Promise<Decision> {
  const rows = await guard(() =>
    db
      .insert(decisions)
      .values({
        id: input.id ?? newId('dec'),
        kind: input.kind,
        status: input.status ?? 'proposed',
        squadId: input.squadId ?? null,
        policyId: input.policyId ?? null,
        actor: input.actor,
        rationale: input.rationale,
        evidence: DecisionSchema.shape.evidence.parse(input.evidence ?? {}),
        payload: input.payload ?? {},
        createdAt: toDate(input.createdAt ?? nowIso()),
      })
      .returning(),
  );
  return toDecision(first(rows, 'insert decision'));
}

export async function find(db: Db, id: string): Promise<Decision | undefined> {
  const rows = await db.select().from(decisions).where(eq(decisions.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toDecision(row);
}

export async function get(db: Db, id: string): Promise<Decision> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('decision', id);
  return found;
}

/** Newest first. */
export async function list(db: Db, options: ListDecisionsOptions = {}): Promise<Page<Decision>> {
  const limit = clampLimit(options.limit, LIMITS);
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, TimeIdCursorSchema);
  const rows = await db
    .select()
    .from(decisions)
    .where(
      and(
        options.squadId === undefined ? undefined : eq(decisions.squadId, options.squadId),
        options.status === undefined ? undefined : eq(decisions.status, options.status),
        options.kind === undefined ? undefined : eq(decisions.kind, options.kind),
        options.policyId === undefined ? undefined : eq(decisions.policyId, options.policyId),
        options.actor === undefined ? undefined : eq(decisions.actor, options.actor),
        cursor === undefined
          ? undefined
          : or(
              lt(decisions.createdAt, toDate(cursor.t)),
              and(eq(decisions.createdAt, toDate(cursor.t)), lt(decisions.id, cursor.i)),
            ),
      ),
    )
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(limit + 1);
  return toPage(rows.map(toDecision), limit, (last) => ({ t: last.createdAt, i: last.id }));
}

export async function setStatus(
  db: Db,
  id: string,
  status: DecisionStatus,
  options: SetDecisionStatusOptions = {},
): Promise<Decision> {
  const now = new Date();
  const decidedAt =
    options.decidedAt !== undefined
      ? toDate(options.decidedAt)
      : status === 'approved' || status === 'rejected'
        ? now
        : undefined;
  const executedAt =
    options.executedAt !== undefined
      ? toDate(options.executedAt)
      : status === 'executed'
        ? now
        : undefined;
  const rows = await guard(() =>
    db
      .update(decisions)
      .set({ status, decidedAt, executedAt, error: options.error })
      .where(eq(decisions.id, id))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('decision', id);
  return toDecision(row);
}
