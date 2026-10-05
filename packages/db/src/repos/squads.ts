import {
  NotFoundError,
  SquadSchema,
  SquadScoreSchema,
  ValidationError,
  newId,
  nowIso,
} from '@agon/spec';
import type { Squad, SquadScore, SquadStatus, TicketSource } from '@agon/spec';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import { compact, first, parseRow, toDate, toIso } from '../internal.js';
import { squads } from '../schema.js';
import type { SquadRow } from '../schema.js';

/** The spec's score fields without their defaults, so a patch only touches the keys it names. */
const SquadScorePatchSchema = z.strictObject({
  runs: SquadScoreSchema.shape.runs.removeDefault().optional(),
  wins: SquadScoreSchema.shape.wins.removeDefault().optional(),
  winRate: SquadScoreSchema.shape.winRate.removeDefault().optional(),
  meanLift: SquadScoreSchema.shape.meanLift.removeDefault().optional(),
  costUsd: SquadScoreSchema.shape.costUsd.removeDefault().optional(),
});

export interface CreateSquadInput {
  id?: string;
  slug: string;
  name: string;
  status?: SquadStatus;
  controlUrl?: string;
  ticketSource?: TicketSource;
  allocation?: number;
  score?: Partial<SquadScore>;
  createdAt?: string;
}

export interface UpdateSquadInput {
  name?: string;
  controlUrl?: string | null;
  ticketSource?: TicketSource | null;
}

export interface ListSquadsOptions {
  status?: SquadStatus;
}

export function toSquad(row: SquadRow): Squad {
  return parseRow(
    SquadSchema,
    compact({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      controlUrl: row.controlUrl ?? undefined,
      ticketSource: row.ticketSource ?? undefined,
      allocation: row.allocation,
      score: row.score,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }),
    'squad',
    row.id,
  );
}

function assertAllocation(allocation: number): void {
  if (!(allocation >= 0 && allocation <= 1)) {
    throw new ValidationError(`allocation must be in [0, 1], got ${allocation}`);
  }
}

export async function create(db: Db, input: CreateSquadInput): Promise<Squad> {
  const allocation = input.allocation ?? 0;
  assertAllocation(allocation);
  const createdAt = toDate(input.createdAt ?? nowIso());
  const rows = await guard(() =>
    db
      .insert(squads)
      .values({
        id: input.id ?? newId('sqd'),
        slug: input.slug,
        name: input.name,
        status: input.status ?? 'active',
        controlUrl: input.controlUrl ?? null,
        ticketSource: input.ticketSource ?? null,
        allocation,
        score: SquadScoreSchema.parse(input.score ?? {}),
        createdAt,
        updatedAt: createdAt,
      })
      .returning(),
  );
  return toSquad(first(rows, 'insert squad'));
}

export async function find(db: Db, id: string): Promise<Squad | undefined> {
  const rows = await db.select().from(squads).where(eq(squads.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toSquad(row);
}

export async function get(db: Db, id: string): Promise<Squad> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('squad', id);
  return found;
}

export async function findBySlug(db: Db, slug: string): Promise<Squad | undefined> {
  const rows = await db.select().from(squads).where(eq(squads.slug, slug)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toSquad(row);
}

export async function getBySlug(db: Db, slug: string): Promise<Squad> {
  const found = await findBySlug(db, slug);
  if (!found) throw new NotFoundError('squad', slug);
  return found;
}

/** Oldest first. */
export async function list(db: Db, options: ListSquadsOptions = {}): Promise<Squad[]> {
  const rows = await db
    .select()
    .from(squads)
    .where(options.status === undefined ? undefined : eq(squads.status, options.status))
    .orderBy(asc(squads.createdAt), asc(squads.id));
  return rows.map(toSquad);
}

async function updateOne(db: Db, id: string, set: Parameters<ReturnType<Db['update']>['set']>[0]) {
  const rows = await guard(() =>
    db
      .update(squads)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(squads.id, id))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('squad', id);
  return toSquad(row);
}

export async function update(db: Db, id: string, patch: UpdateSquadInput): Promise<Squad> {
  return updateOne(db, id, {
    name: patch.name,
    controlUrl: patch.controlUrl,
    ticketSource: patch.ticketSource,
  });
}

/** Callers must have written a `Decision` first (CLAUDE.md invariant 6). */
export async function setStatus(db: Db, id: string, status: SquadStatus): Promise<Squad> {
  return updateOne(db, id, { status });
}

export async function setAllocation(db: Db, id: string, allocation: number): Promise<Squad> {
  assertAllocation(allocation);
  return updateOne(db, id, { allocation });
}

/** Merges the given fields into the stored score. */
export async function updateScore(db: Db, id: string, patch: Partial<SquadScore>): Promise<Squad> {
  const parsed = SquadScorePatchSchema.safeParse(compact(patch));
  if (!parsed.success) throw new ValidationError('invalid score patch', parsed.error.issues);
  return updateOne(db, id, {
    score: sql`${squads.score} || ${JSON.stringify(parsed.data)}::jsonb`,
  });
}
