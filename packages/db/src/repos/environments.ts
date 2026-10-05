import { EnvironmentSchema, NotFoundError, newId, nowIso } from '@agon/spec';
import type { AgonConfig, Environment } from '@agon/spec';
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
  toPage,
} from '../internal.js';
import { environments } from '../schema.js';
import type { EnvironmentRow } from '../schema.js';
import type { Page, PageOptions } from '../types.js';

const LIMITS = { default: 50, max: 200 };

export interface CreateEnvironmentInput {
  id?: string;
  /** Defaults to `config.name`. */
  name?: string;
  config: AgonConfig;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateEnvironmentInput {
  name?: string;
  config?: AgonConfig;
}

export interface ListEnvironmentsOptions extends PageOptions {
  name?: string;
}

export function toEnvironment(row: EnvironmentRow): Environment {
  return parseRow(
    EnvironmentSchema,
    {
      id: row.id,
      name: row.name,
      config: row.config,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    },
    'environment',
    row.id,
  );
}

export async function create(db: Db, input: CreateEnvironmentInput): Promise<Environment> {
  const createdAt = input.createdAt ?? nowIso();
  const rows = await guard(() =>
    db
      .insert(environments)
      .values({
        id: input.id ?? newId('env'),
        name: input.name ?? input.config.name,
        config: input.config,
        createdAt: toDate(createdAt),
        updatedAt: toDate(input.updatedAt ?? createdAt),
      })
      .returning(),
  );
  return toEnvironment(first(rows, 'insert environment'));
}

export async function find(db: Db, id: string): Promise<Environment | undefined> {
  const rows = await db.select().from(environments).where(eq(environments.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toEnvironment(row);
}

export async function get(db: Db, id: string): Promise<Environment> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('environment', id);
  return found;
}

/** Newest first. */
export async function list(
  db: Db,
  options: ListEnvironmentsOptions = {},
): Promise<Page<Environment>> {
  const limit = clampLimit(options.limit, LIMITS);
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, TimeIdCursorSchema);
  const rows = await db
    .select()
    .from(environments)
    .where(
      and(
        options.name === undefined ? undefined : eq(environments.name, options.name),
        cursor === undefined
          ? undefined
          : or(
              lt(environments.createdAt, toDate(cursor.t)),
              and(eq(environments.createdAt, toDate(cursor.t)), lt(environments.id, cursor.i)),
            ),
      ),
    )
    .orderBy(desc(environments.createdAt), desc(environments.id))
    .limit(limit + 1);
  return toPage(rows.map(toEnvironment), limit, (last) => ({ t: last.createdAt, i: last.id }));
}

export async function update(
  db: Db,
  id: string,
  patch: UpdateEnvironmentInput,
): Promise<Environment> {
  const rows = await guard(() =>
    db
      .update(environments)
      .set({ ...compact({ name: patch.name, config: patch.config }), updatedAt: new Date() })
      .where(eq(environments.id, id))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('environment', id);
  return toEnvironment(row);
}

/** Deletes the environment and, through cascades, its variants, runs, sessions, steps, events and results. */
export async function remove(db: Db, id: string): Promise<void> {
  const rows = await guard(() =>
    db.delete(environments).where(eq(environments.id, id)).returning({ id: environments.id }),
  );
  if (rows.length === 0) throw new NotFoundError('environment', id);
}

export { remove as delete };
