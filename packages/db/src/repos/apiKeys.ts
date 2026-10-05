import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError, newId, nowIso } from '@agon/spec';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import { compact, first, parseRow, toDate, toIso, toIsoOrUndefined } from '../internal.js';
import { apiKeys } from '../schema.js';
import type { ApiKeyRow } from '../schema.js';
import { ApiKeySchema } from '../types.js';
import type { ApiKey, ApiKeyRole } from '../types.js';

export const API_KEY_PREFIX = 'agon_';

export interface CreateApiKeyInput {
  id?: string;
  role: ApiKeyRole;
  /** Required for `squad` keys, forbidden otherwise. */
  squadId?: string;
  label: string;
  /** Use this secret instead of generating one, e.g. to bootstrap keys from configuration. */
  key?: string;
  createdAt?: string;
}

export interface CreatedApiKey {
  /** The secret. It is shown once and never stored. */
  key: string;
  apiKey: ApiKey;
}

export interface ListApiKeysOptions {
  squadId?: string;
  includeRevoked?: boolean;
}

/** SHA-256 hex digest; the only form of a key that is ever stored or looked up. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** A fresh secret with 256 bits of entropy. */
export function generateKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function isActive(apiKey: ApiKey): boolean {
  return apiKey.revokedAt === undefined;
}

export function toApiKey(row: ApiKeyRow): ApiKey {
  return parseRow(
    ApiKeySchema,
    compact({
      id: row.id,
      keyHash: row.keyHash,
      role: row.role,
      squadId: row.squadId ?? undefined,
      label: row.label,
      createdAt: toIso(row.createdAt),
      lastUsedAt: toIsoOrUndefined(row.lastUsedAt),
      revokedAt: toIsoOrUndefined(row.revokedAt),
    }),
    'api key',
    row.id,
  );
}

export async function create(db: Db, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  if (input.role === 'squad' && input.squadId === undefined) {
    throw new ValidationError('squad API keys must belong to a squad');
  }
  if (input.role !== 'squad' && input.squadId !== undefined) {
    throw new ValidationError(`${input.role} API keys cannot belong to a squad`);
  }
  if (input.key !== undefined && input.key.length < 16) {
    throw new ValidationError('API keys must be at least 16 characters');
  }
  const key = input.key ?? generateKey();
  const rows = await guard(() =>
    db
      .insert(apiKeys)
      .values({
        id: input.id ?? newId('key'),
        keyHash: hashKey(key),
        role: input.role,
        squadId: input.squadId ?? null,
        label: input.label,
        createdAt: toDate(input.createdAt ?? nowIso()),
      })
      .returning(),
  );
  return { key, apiKey: toApiKey(first(rows, 'insert api key')) };
}

export async function findByHash(db: Db, keyHash: string): Promise<ApiKey | undefined> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toApiKey(row);
}

/** Looks a secret up by its hash. Callers must still check `isActive`. */
export async function findByKey(db: Db, key: string): Promise<ApiKey | undefined> {
  return findByHash(db, hashKey(key));
}

export async function find(db: Db, id: string): Promise<ApiKey | undefined> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toApiKey(row);
}

export async function get(db: Db, id: string): Promise<ApiKey> {
  const found = await find(db, id);
  if (!found) throw new NotFoundError('api key', id);
  return found;
}

/** Oldest first; revoked keys are left out unless asked for. */
export async function list(db: Db, options: ListApiKeysOptions = {}): Promise<ApiKey[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        options.squadId === undefined ? undefined : eq(apiKeys.squadId, options.squadId),
        options.includeRevoked ? undefined : isNull(apiKeys.revokedAt),
      ),
    )
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
  return rows.map(toApiKey);
}

/** Records that the key was just used. */
export async function touch(db: Db, id: string, at: string = nowIso()): Promise<void> {
  await guard(() =>
    db
      .update(apiKeys)
      .set({ lastUsedAt: toDate(at) })
      .where(eq(apiKeys.id, id)),
  );
}

/** Revokes the key. Revoking an already revoked key keeps the original revocation time. */
export async function revoke(db: Db, id: string, at: string = nowIso()): Promise<ApiKey> {
  const rows = await guard(() =>
    db
      .update(apiKeys)
      .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${toDate(at)})` })
      .where(eq(apiKeys.id, id))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('api key', id);
  return toApiKey(row);
}
