import { NotFoundError } from '@agon/spec';
import type { VariantSpec } from '@agon/spec';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import { compact, first, parseRow, toDate, toIso } from '../internal.js';
import { variants } from '../schema.js';
import type { VariantRow } from '../schema.js';
import { VariantSchema } from '../types.js';
import type { Variant } from '../types.js';

/** Variant ids derive from their natural key, so registering the same variant twice is idempotent. */
export function variantId(environmentId: string, name: string): string {
  const suffix = environmentId.includes('_')
    ? environmentId.slice(environmentId.indexOf('_') + 1)
    : environmentId;
  return `var_${suffix}_${name}`;
}

export interface UpsertVariantInput {
  environmentId: string;
  name: string;
  spec: VariantSpec;
  /** Squad credited with the variant. On update, `undefined` keeps the stored value and `null` clears it. */
  squadId?: string | null;
  /** Defaults to `spec.gitRef`. */
  gitRef?: string | null;
  id?: string;
  createdAt?: string;
}

export function toVariant(row: VariantRow): Variant {
  return parseRow(
    VariantSchema,
    compact({
      id: row.id,
      environmentId: row.environmentId,
      name: row.name,
      spec: row.spec,
      squadId: row.squadId ?? undefined,
      gitRef: row.gitRef ?? undefined,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }),
    'variant',
    row.id,
  );
}

/** Registers a variant, replacing the spec of an existing variant with the same name. */
export async function upsert(db: Db, input: UpsertVariantInput): Promise<Variant> {
  const now = new Date();
  const gitRef = input.gitRef === undefined ? (input.spec.gitRef ?? null) : input.gitRef;
  const squadId = input.squadId ?? null;
  const rows = await guard(() =>
    db
      .insert(variants)
      .values({
        id: input.id ?? variantId(input.environmentId, input.name),
        environmentId: input.environmentId,
        name: input.name,
        spec: input.spec,
        squadId,
        gitRef,
        createdAt: input.createdAt === undefined ? now : toDate(input.createdAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [variants.environmentId, variants.name],
        set: {
          spec: input.spec,
          gitRef,
          updatedAt: now,
          ...(input.squadId === undefined ? {} : { squadId }),
        },
      })
      .returning(),
  );
  return toVariant(first(rows, 'upsert variant'));
}

/** Variants of an environment, by name. */
export async function list(db: Db, environmentId: string): Promise<Variant[]> {
  const rows = await db
    .select()
    .from(variants)
    .where(eq(variants.environmentId, environmentId))
    .orderBy(asc(variants.name));
  return rows.map(toVariant);
}

export async function find(
  db: Db,
  environmentId: string,
  name: string,
): Promise<Variant | undefined> {
  const rows = await db
    .select()
    .from(variants)
    .where(and(eq(variants.environmentId, environmentId), eq(variants.name, name)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toVariant(row);
}

export async function get(db: Db, environmentId: string, name: string): Promise<Variant> {
  const found = await find(db, environmentId, name);
  if (!found) throw new NotFoundError('variant', `${environmentId}/${name}`);
  return found;
}

export async function findById(db: Db, id: string): Promise<Variant | undefined> {
  const rows = await db.select().from(variants).where(eq(variants.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toVariant(row);
}

export async function getById(db: Db, id: string): Promise<Variant> {
  const found = await findById(db, id);
  if (!found) throw new NotFoundError('variant', id);
  return found;
}

export async function remove(db: Db, environmentId: string, name: string): Promise<void> {
  const rows = await guard(() =>
    db
      .delete(variants)
      .where(and(eq(variants.environmentId, environmentId), eq(variants.name, name)))
      .returning({ id: variants.id }),
  );
  if (rows.length === 0) throw new NotFoundError('variant', `${environmentId}/${name}`);
}

export { remove as delete };
