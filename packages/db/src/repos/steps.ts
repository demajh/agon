import { NotFoundError, StepSchema } from '@agon/spec';
import type { Step } from '@agon/spec';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import { chunk, parseRow, toDate, toIso } from '../internal.js';
import { steps } from '../schema.js';
import type { StepRow } from '../schema.js';

const INSERT_CHUNK = 200;

export function toStep(row: StepRow): Step {
  return parseRow(
    StepSchema,
    {
      id: row.id,
      sessionId: row.sessionId,
      index: row.index,
      observation: row.observation,
      decision: row.decision,
      result: row.result,
      patience: row.patience,
      usage: row.usage,
      startedAt: toIso(row.startedAt),
      durationMs: row.durationMs,
    },
    'step',
    row.id,
  );
}

function toRow(step: Step) {
  return {
    id: step.id,
    sessionId: step.sessionId,
    index: step.index,
    observation: step.observation,
    decision: step.decision,
    result: step.result,
    patience: step.patience,
    usage: step.usage,
    startedAt: toDate(step.startedAt),
    durationMs: step.durationMs,
  };
}

/** Inserts steps in bulk; all or nothing. Returns how many were inserted. */
export async function insertMany(db: Db, items: Step[]): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map(toRow);
  const batches = chunk(rows, INSERT_CHUNK);
  await guard(async () => {
    if (batches.length === 1) {
      await db.insert(steps).values(batches[0] ?? []);
      return;
    }
    await db.transaction(async (tx) => {
      for (const batch of batches) await tx.insert(steps).values(batch);
    });
  });
  return items.length;
}

/** Steps of a session in index order. */
export async function listBySession(db: Db, sessionId: string): Promise<Step[]> {
  const rows = await db
    .select()
    .from(steps)
    .where(eq(steps.sessionId, sessionId))
    .orderBy(asc(steps.index));
  return rows.map(toStep);
}

export async function find(db: Db, id: string): Promise<Step | undefined> {
  const rows = await db.select().from(steps).where(eq(steps.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toStep(row);
}

export async function get(db: Db, id: string): Promise<Step> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('step', id);
  return found;
}
