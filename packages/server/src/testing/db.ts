import { Client, Pool } from 'pg';

/**
 * Server tests use their own database so they can run next to the db package's `agon_test` suite
 * (turbo runs packages in parallel). `DATABASE_URL` names the server; set `AGON_SKIP_DB_TESTS=1`
 * to skip everything that needs Postgres.
 */
export const TEST_DATABASE = 'agon_server_test';
export const SKIP_DB_TESTS = process.env['AGON_SKIP_DB_TESTS'] === '1';
export const DEFAULT_DATABASE_URL = 'postgres://agon:agon@localhost:5432/agon';

export function baseDatabaseUrl(): string {
  return process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}

export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export function testDatabaseUrl(): string {
  return withDatabase(baseDatabaseUrl(), TEST_DATABASE);
}

/** Creates `agon_server_test` through the `postgres` maintenance database unless it exists. */
export async function ensureTestDatabase(): Promise<string> {
  const client = new Client({ connectionString: withDatabase(baseDatabaseUrl(), 'postgres') });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Postgres is not reachable at ${baseDatabaseUrl()}; start it with "docker compose up -d postgres" or set AGON_SKIP_DB_TESTS=1 (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [
      TEST_DATABASE,
    ]);
    if (existing.rowCount === 0) {
      try {
        await client.query(`create database "${TEST_DATABASE}"`);
      } catch (error) {
        // Another worker may have created it meanwhile (42P04 = duplicate_database).
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await client.end();
  }
  return testDatabaseUrl();
}

/** Application tables, in no particular order; truncation cascades. */
export const APP_TABLES = [
  'environments',
  'squads',
  'variants',
  'runs',
  'sessions',
  'steps',
  'events',
  'results',
  'decisions',
  'api_keys',
];

/** Empties every application table (test isolation only; production code never issues SQL here). */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`truncate table ${APP_TABLES.map((t) => `"${t}"`).join(', ')} cascade`);
}
