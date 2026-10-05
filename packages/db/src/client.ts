import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import * as schema from './schema.js';

export type Schema = typeof schema;

/**
 * What every repository function accepts as its first argument: the client returned by
 * `createDb` or a transaction opened on it with `db.transaction(async (tx) => ...)`.
 */
export type Db = PgDatabase<NodePgQueryResultHKT, Schema>;
export type DbTransaction = PgTransaction<
  NodePgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
/** The concrete client created by `createDb`; `migrate` needs this one. */
export type DbClient = NodePgDatabase<Schema> & { $client: Pool };

export const DEFAULT_DATABASE_URL = 'postgres://agon:agon@localhost:5432/agon';

/** `DATABASE_URL`, falling back to the compose stack's Postgres. */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}

/** The connection string with its password hidden, for logs and error messages. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<connection string>';
  }
}

export interface CreateDbOptions {
  /** Passed to `pg.Pool`; `connectionString` is always taken from the first argument. */
  pool?: Omit<PoolConfig, 'connectionString'>;
  /** Log every statement to stdout (development only). */
  logger?: boolean;
}

export interface DbHandle {
  db: DbClient;
  pool: Pool;
  /** Drains and closes the pool. Safe to call more than once. */
  close(): Promise<void>;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new Pool({ ...options.pool, connectionString });
  const db = drizzle(pool, { schema, logger: options.logger ?? false });
  let closing: Promise<void> | undefined;
  return {
    db,
    pool,
    close: () => {
      closing ??= pool.end();
      return closing;
    },
  };
}
