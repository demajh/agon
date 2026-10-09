import { NotFoundError, ResultSchema } from '@agon/spec';
import type { Result } from '@agon/spec';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import { compact, first, parseRow, toDate, toIso } from '../internal.js';
import { results } from '../schema.js';
import type { ResultRow } from '../schema.js';

export function toResult(row: ResultRow): Result {
  return parseRow(
    ResultSchema,
    compact({
      id: row.id,
      runId: row.runId,
      method: row.method,
      control: row.control,
      primaryMetricId: row.primaryMetricId,
      metrics: row.metrics,
      decision: row.decision,
      calibration: row.calibration,
      sessionsAnalyzed: row.sessionsAnalyzed,
      computedAt: toIso(row.computedAt),
      engine: row.engine,
      kind: row.kind,
      assumptions: row.assumptions,
      requirementsDigest: row.requirementsDigest ?? undefined,
    }),
    'result',
    row.id,
  );
}

function toRow(result: Result) {
  return {
    id: result.id,
    runId: result.runId,
    method: result.method,
    control: result.control,
    primaryMetricId: result.primaryMetricId,
    metrics: result.metrics,
    decision: result.decision,
    calibration: result.calibration,
    sessionsAnalyzed: result.sessionsAnalyzed,
    computedAt: toDate(result.computedAt),
    engine: result.engine,
    kind: result.kind,
    assumptions: result.assumptions,
    requirementsDigest: result.requirementsDigest ?? null,
  };
}

/** Stores a run's result. A run has at most one; a second insert is a `ConflictError`. */
export async function insert(db: Db, result: Result): Promise<Result> {
  const rows = await guard(() => db.insert(results).values(toRow(result)).returning());
  return toResult(first(rows, 'insert result'));
}

/** Stores a run's result, replacing an earlier analysis of the same run. */
export async function upsert(db: Db, result: Result): Promise<Result> {
  const row = toRow(result);
  const rows = await guard(() =>
    db
      .insert(results)
      .values(row)
      .onConflictDoUpdate({
        target: results.runId,
        set: {
          id: row.id,
          method: row.method,
          control: row.control,
          primaryMetricId: row.primaryMetricId,
          metrics: row.metrics,
          decision: row.decision,
          calibration: row.calibration,
          sessionsAnalyzed: row.sessionsAnalyzed,
          computedAt: row.computedAt,
          engine: row.engine,
          kind: row.kind,
          assumptions: row.assumptions,
          requirementsDigest: row.requirementsDigest,
        },
      })
      .returning(),
  );
  return toResult(first(rows, 'upsert result'));
}

export async function find(db: Db, id: string): Promise<Result | undefined> {
  const rows = await db.select().from(results).where(eq(results.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toResult(row);
}

export async function get(db: Db, id: string): Promise<Result> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('result', id);
  return found;
}

export async function findByRun(db: Db, runId: string): Promise<Result | undefined> {
  const rows = await db.select().from(results).where(eq(results.runId, runId)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toResult(row);
}

export async function getByRun(db: Db, runId: string): Promise<Result> {
  const found = await findByRun(db, runId);
  if (!found) throw new NotFoundError('result for run', runId);
  return found;
}
