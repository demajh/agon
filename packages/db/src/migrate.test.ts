import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, expect, it } from 'vitest';
import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, migrate } from './migrate.js';
import { describeDb, dropDatabase, ensureDatabase, testDatabaseUrl } from './testing/db.js';

const FRESH_DATABASE = 'agon_test_migrate';

describeDb('migrate', () => {
  afterAll(async () => {
    await dropDatabase(FRESH_DATABASE);
  });

  it('applies every migration to a fresh database, idempotently and under concurrency', async () => {
    await dropDatabase(FRESH_DATABASE);
    await ensureDatabase(FRESH_DATABASE);
    const handle = createDb(testDatabaseUrl(FRESH_DATABASE), { pool: { max: 3 } });
    try {
      await migrate(handle.db);

      const tables = await handle.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );
      expect(tables.rows.map((row) => row['table_name'])).toEqual([
        'api_keys',
        'decisions',
        'environments',
        'evaluation_ledger',
        'events',
        'findings',
        'results',
        'runs',
        'sessions',
        'squads',
        'steps',
        'variants',
      ]);

      const enums = await handle.db.execute(
        sql`select typname from pg_type where typtype = 'e' order by typname`,
      );
      expect(enums.rows.map((row) => row['typname'])).toEqual([
        'analysis_method',
        'analytics_provider',
        'api_key_role',
        'decision_actor',
        'decision_status',
        'event_source',
        'finding_status',
        'ledger_event',
        'ledger_role',
        'policy_action',
        'result_kind',
        'run_status',
        'session_outcome',
        'session_status',
        'squad_status',
      ]);

      // Re-running, even concurrently, applies nothing twice.
      await Promise.all([migrate(handle.db), migrate(handle.db), migrate(handle.db)]);
      const applied = await handle.db.execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      expect(applied.rows[0]?.['n']).toBe(
        readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length,
      );
    } finally {
      await handle.close();
    }
  });
});
