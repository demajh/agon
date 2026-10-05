import { NotFoundError, RunCountsSchema, RunSchema, newId, nowIso } from '@agon/spec';
import type { AgonConfig, Run, RunStatus } from '@agon/spec';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
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
  toDateOrNull,
  toIso,
  toIsoOrUndefined,
  toPage,
} from '../internal.js';
import { runs } from '../schema.js';
import type { RunRow } from '../schema.js';
import type { Page, PageOptions } from '../types.js';

const LIMITS = { default: 50, max: 500 };

export type RunCounts = Run['counts'];
const COUNT_KEYS = Object.keys(RunCountsSchema.shape) as (keyof RunCounts)[];
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

export interface CreateRunInput {
  id?: string;
  environmentId: string;
  variants: string[];
  seed: number;
  /** Snapshot of the environment config at run time. */
  config: AgonConfig;
  status?: RunStatus;
  counts?: Partial<RunCounts>;
  createdAt?: string;
}

export interface ListRunsOptions extends PageOptions {
  status?: RunStatus;
}

export interface SetRunStatusOptions {
  /** Defaults to now when the run becomes `running` and has no start time yet. */
  startedAt?: string;
  /** Defaults to now when the status is terminal. */
  finishedAt?: string;
  error?: string | null;
}

export function toRun(row: RunRow): Run {
  return parseRow(
    RunSchema,
    compact({
      id: row.id,
      environmentId: row.environmentId,
      status: row.status,
      variants: row.variants,
      seed: row.seed,
      config: row.config,
      counts: row.counts,
      costUsd: row.costUsd,
      resultId: row.resultId ?? undefined,
      createdAt: toIso(row.createdAt),
      startedAt: toIsoOrUndefined(row.startedAt),
      finishedAt: toIsoOrUndefined(row.finishedAt),
      error: row.error ?? undefined,
    }),
    'run',
    row.id,
  );
}

function toRow(run: Run) {
  return {
    id: run.id,
    environmentId: run.environmentId,
    status: run.status,
    variants: run.variants,
    seed: run.seed,
    config: run.config,
    counts: run.counts,
    costUsd: run.costUsd,
    resultId: run.resultId ?? null,
    createdAt: toDate(run.createdAt),
    startedAt: toDateOrNull(run.startedAt),
    finishedAt: toDateOrNull(run.finishedAt),
    error: run.error ?? null,
  };
}

export async function create(db: Db, input: CreateRunInput): Promise<Run> {
  const rows = await guard(() =>
    db
      .insert(runs)
      .values({
        id: input.id ?? newId('run'),
        environmentId: input.environmentId,
        status: input.status ?? 'queued',
        variants: input.variants,
        seed: input.seed,
        config: input.config,
        counts: RunCountsSchema.parse(input.counts ?? {}),
        costUsd: 0,
        createdAt: toDate(input.createdAt ?? nowIso()),
      })
      .returning(),
  );
  return toRun(first(rows, 'insert run'));
}

/** Inserts the run, or overwrites every mutable field of the stored one. The recorder uses this. */
export async function upsert(db: Db, run: Run): Promise<Run> {
  const row = toRow(run);
  const rows = await guard(() =>
    db
      .insert(runs)
      .values(row)
      .onConflictDoUpdate({
        target: runs.id,
        set: {
          status: row.status,
          variants: row.variants,
          seed: row.seed,
          config: row.config,
          counts: row.counts,
          costUsd: row.costUsd,
          resultId: row.resultId,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          error: row.error,
        },
      })
      .returning(),
  );
  return toRun(first(rows, 'upsert run'));
}

export async function find(db: Db, id: string): Promise<Run | undefined> {
  const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toRun(row);
}

export async function get(db: Db, id: string): Promise<Run> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('run', id);
  return found;
}

/** Newest first. */
export async function listByEnvironment(
  db: Db,
  environmentId: string,
  options: ListRunsOptions = {},
): Promise<Page<Run>> {
  const limit = clampLimit(options.limit, LIMITS);
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, TimeIdCursorSchema);
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.environmentId, environmentId),
        options.status === undefined ? undefined : eq(runs.status, options.status),
        cursor === undefined
          ? undefined
          : or(
              lt(runs.createdAt, toDate(cursor.t)),
              and(eq(runs.createdAt, toDate(cursor.t)), lt(runs.id, cursor.i)),
            ),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1);
  return toPage(rows.map(toRun), limit, (last) => ({ t: last.createdAt, i: last.id }));
}

async function updateOne(db: Db, id: string, set: Parameters<ReturnType<Db['update']>['set']>[0]) {
  const rows = await guard(() => db.update(runs).set(set).where(eq(runs.id, id)).returning());
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('run', id);
  return toRun(row);
}

export async function setStatus(
  db: Db,
  id: string,
  status: RunStatus,
  options: SetRunStatusOptions = {},
): Promise<Run> {
  const now = new Date();
  const startedAt =
    options.startedAt !== undefined
      ? toDate(options.startedAt)
      : status === 'running'
        ? sql`coalesce(${runs.startedAt}, ${now})`
        : undefined;
  const finishedAt =
    options.finishedAt !== undefined
      ? toDate(options.finishedAt)
      : TERMINAL_STATUSES.has(status)
        ? now
        : undefined;
  return updateOne(db, id, { status, startedAt, finishedAt, error: options.error });
}

/** Atomically adds the deltas to the stored session counts (never below zero). */
export async function bumpCounts(db: Db, id: string, delta: Partial<RunCounts>): Promise<Run> {
  const pairs = COUNT_KEYS.flatMap((key) => {
    const value = delta[key];
    if (value === undefined || value === 0) return [];
    return [
      sql`${key}::text, greatest(0, coalesce((${runs.counts}->>${key}::text)::int, 0) + ${value}::int)`,
    ];
  });
  if (pairs.length === 0) return get(db, id);
  return updateOne(db, id, {
    counts: sql`${runs.counts} || jsonb_build_object(${sql.join(pairs, sql`, `)})`,
  });
}

/** Atomically adds to the run's accumulated cost. */
export async function addCost(db: Db, id: string, usd: number): Promise<Run> {
  return updateOne(db, id, { costUsd: sql`${runs.costUsd} + ${usd}::double precision` });
}

export async function setResult(db: Db, id: string, resultId: string): Promise<Run> {
  return updateOne(db, id, { resultId });
}
