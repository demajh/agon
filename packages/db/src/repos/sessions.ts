import { NotFoundError, SessionSchema, nowIso } from '@agon/spec';
import type { Judgement, Session, SessionOutcome, SessionStatus } from '@agon/spec';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import {
  IndexCursorSchema,
  clampLimit,
  compact,
  decodeCursor,
  first,
  parseRow,
  toDate,
  toDateOrNull,
  toIsoOrUndefined,
  toPage,
} from '../internal.js';
import { sessions } from '../schema.js';
import type { SessionRow } from '../schema.js';
import type { Page, PageOptions } from '../types.js';

const LIMITS = { default: 100, max: 1000 };

export interface ListSessionsOptions extends PageOptions {
  status?: SessionStatus;
  variant?: string;
}

export interface FinishSessionInput {
  /** Defaults to `failed` when an error or the `error` outcome is given, `finished` otherwise. */
  status?: Extract<SessionStatus, 'finished' | 'failed'>;
  outcome?: SessionOutcome;
  outcomeReason?: string;
  steps?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  metrics?: Record<string, number>;
  judgement?: Judgement;
  /** Defaults to now. */
  finishedAt?: string;
  error?: string;
}

export function toSession(row: SessionRow): Session {
  return parseRow(
    SessionSchema,
    compact({
      id: row.id,
      runId: row.runId,
      index: row.index,
      variant: row.variant,
      scenarioId: row.scenarioId,
      persona: row.persona,
      status: row.status,
      outcome: row.outcome ?? undefined,
      outcomeReason: row.outcomeReason ?? undefined,
      steps: row.steps,
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      metrics: row.metrics,
      judgement: row.judgement ?? undefined,
      maxStepsSinceProgress: row.maxStepsSinceProgress ?? undefined,
      lastProgressStep: row.lastProgressStep ?? undefined,
      progressSteps: row.progressSteps ?? undefined,
      startedAt: toIsoOrUndefined(row.startedAt),
      finishedAt: toIsoOrUndefined(row.finishedAt),
      error: row.error ?? undefined,
    }),
    'session',
    row.id,
  );
}

function toRow(session: Session) {
  return {
    id: session.id,
    runId: session.runId,
    index: session.index,
    variant: session.variant,
    scenarioId: session.scenarioId,
    persona: session.persona,
    status: session.status,
    outcome: session.outcome ?? null,
    outcomeReason: session.outcomeReason ?? null,
    steps: session.steps,
    costUsd: session.costUsd,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    metrics: session.metrics,
    judgement: session.judgement ?? null,
    maxStepsSinceProgress: session.maxStepsSinceProgress ?? null,
    lastProgressStep: session.lastProgressStep ?? null,
    progressSteps: session.progressSteps ?? null,
    startedAt: toDateOrNull(session.startedAt),
    finishedAt: toDateOrNull(session.finishedAt),
    error: session.error ?? null,
  };
}

/** Inserts the session, or overwrites every mutable field of the stored one. */
export async function upsert(db: Db, session: Session): Promise<Session> {
  const row = toRow(session);
  const rows = await guard(() =>
    db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          index: row.index,
          variant: row.variant,
          scenarioId: row.scenarioId,
          persona: row.persona,
          status: row.status,
          outcome: row.outcome,
          outcomeReason: row.outcomeReason,
          steps: row.steps,
          costUsd: row.costUsd,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          metrics: row.metrics,
          judgement: row.judgement,
          maxStepsSinceProgress: row.maxStepsSinceProgress,
          lastProgressStep: row.lastProgressStep,
          progressSteps: row.progressSteps,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          error: row.error,
        },
      })
      .returning(),
  );
  return toSession(first(rows, 'upsert session'));
}

export async function find(db: Db, id: string): Promise<Session | undefined> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toSession(row);
}

export async function get(db: Db, id: string): Promise<Session> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('session', id);
  return found;
}

/** Sessions of a run in index order. */
export async function listByRun(
  db: Db,
  runId: string,
  options: ListSessionsOptions = {},
): Promise<Page<Session>> {
  const limit = clampLimit(options.limit, LIMITS);
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, IndexCursorSchema);
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.runId, runId),
        options.status === undefined ? undefined : eq(sessions.status, options.status),
        options.variant === undefined ? undefined : eq(sessions.variant, options.variant),
        cursor === undefined ? undefined : gt(sessions.index, cursor.i),
      ),
    )
    .orderBy(asc(sessions.index))
    .limit(limit + 1);
  return toPage(rows.map(toSession), limit, (last) => ({ i: last.index }));
}

async function updateOne(db: Db, id: string, set: Parameters<ReturnType<Db['update']>['set']>[0]) {
  const rows = await guard(() =>
    db.update(sessions).set(set).where(eq(sessions.id, id)).returning(),
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('session', id);
  return toSession(row);
}

/** Records the end of a session: outcome, totals, optional judgement. */
export async function finish(db: Db, id: string, input: FinishSessionInput): Promise<Session> {
  const status =
    input.status ??
    (input.error !== undefined || input.outcome === 'error' ? 'failed' : 'finished');
  return updateOne(db, id, {
    status,
    outcome: input.outcome,
    outcomeReason: input.outcomeReason,
    steps: input.steps,
    costUsd: input.costUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    metrics: input.metrics,
    judgement: input.judgement,
    error: input.error,
    finishedAt: toDate(input.finishedAt ?? nowIso()),
  });
}

export async function setJudgement(db: Db, id: string, judgement: Judgement): Promise<Session> {
  return updateOne(db, id, { judgement });
}
