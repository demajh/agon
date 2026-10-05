import { defineConfig } from 'drizzle-kit';

// `pnpm -F @agon/db db:generate` diffs src/schema.ts against the snapshots in drizzle/ and writes
// a new SQL migration there. Migrations are applied by src/migrate.ts, never by drizzle-kit push.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://agon:agon@localhost:5432/agon',
  },
  strict: true,
  verbose: true,
});
