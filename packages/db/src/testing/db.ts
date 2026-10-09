import { getTableName, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { createDb, databaseUrl, redactConnectionString } from '../client.js';
import type { Db, DbClient, DbHandle } from '../client.js';
import { PG_ERROR_CODES, isPgError } from '../errors.js';
import { migrate } from '../migrate.js';
import * as schema from '../schema.js';

/**
 * Database tests run against a dedicated `agon_test` database on the server named by
 * `DATABASE_URL` (default: the compose stack). Set `AGON_SKIP_DB_TESTS=1` to skip them.
 */
export const SKIP_DB_TESTS = process.env['AGON_SKIP_DB_TESTS'] === '1';
export const TEST_DATABASE = 'agon_test';

/** `describe` for suites that need Postgres; skipped when `AGON_SKIP_DB_TESTS=1`. */
export function describeDb(name: string, factory: () => void): void {
  if (SKIP_DB_TESTS) describe.skip(name, factory);
  else describe(name, factory);
}

const DATABASE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function assertDatabaseName(database: string): void {
  if (!DATABASE_NAME_RE.test(database)) throw new Error(`unsafe database name: ${database}`);
}

/** The server's connection string pointed at another database. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export function testDatabaseUrl(database: string = TEST_DATABASE): string {
  return withDatabase(databaseUrl(), database);
}

async function maintenanceClient(): Promise<Client> {
  const url = withDatabase(databaseUrl(), 'postgres');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      [
        `Postgres is not reachable at ${redactConnectionString(url)}.`,
        'Start it with "docker compose up -d postgres" or point DATABASE_URL at a server;',
        'set AGON_SKIP_DB_TESTS=1 to skip the database tests instead.',
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    );
  }
  return client;
}

/** Creates the database unless it exists, through the `postgres` maintenance database. */
export async function ensureDatabase(database: string): Promise<void> {
  assertDatabaseName(database);
  const client = await maintenanceClient();
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (existing.rowCount === 0) {
      try {
        await client.query(`create database "${database}"`);
      } catch (error) {
        // Another test worker may have created it in the meantime.
        if (!isPgError(error, PG_ERROR_CODES.duplicateDatabase)) throw error;
      }
    }
  } finally {
    await client.end();
  }
}

/** Drops the database, disconnecting anyone still using it. */
export async function dropDatabase(database: string): Promise<void> {
  assertDatabaseName(database);
  const client = await maintenanceClient();
  try {
    await client.query(`drop database if exists "${database}" with (force)`);
  } finally {
    await client.end();
  }
}

/** Every table in dependency-agnostic order; truncation cascades. */
export const ALL_TABLES = [
  schema.environments,
  schema.squads,
  schema.variants,
  schema.runs,
  schema.sessions,
  schema.steps,
  schema.events,
  schema.results,
  schema.decisions,
  schema.apiKeys,
  schema.evaluationLedger,
  schema.findings,
];

export async function truncateAll(db: Db): Promise<void> {
  const names = ALL_TABLES.map((table) => `"${getTableName(table)}"`).join(', ');
  await db.execute(sql.raw(`truncate table ${names} cascade`));
}

export interface TestDb extends DbHandle {
  url: string;
  truncate(): Promise<void>;
}

/** Creates the test database if needed, migrates it, and returns a connected handle. */
export async function setupTestDb(database: string = TEST_DATABASE): Promise<TestDb> {
  await ensureDatabase(database);
  const url = testDatabaseUrl(database);
  const handle = createDb(url, { pool: { max: 4 } });
  try {
    await migrate(handle.db);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { ...handle, url, truncate: () => truncateAll(handle.db) };
}

/**
 * Registers the suite hooks: connect and migrate once, truncate every table before each test,
 * close afterwards. `db` is only valid inside tests.
 */
export function useTestDb(): { readonly db: DbClient; readonly handle: TestDb } {
  let current: TestDb | undefined;
  beforeAll(async () => {
    current = await setupTestDb();
  });
  beforeEach(async () => {
    await current?.truncate();
  });
  afterAll(async () => {
    await current?.close();
  });
  const handle = (): TestDb => {
    if (!current) throw new Error('the test database is only available inside tests');
    return current;
  };
  return {
    get db() {
      return handle().db;
    },
    get handle() {
      return handle();
    },
  };
}
