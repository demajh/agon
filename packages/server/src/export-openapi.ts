/**
 * Writes the OpenAPI document to the given path: `tsx src/export-openapi.ts ../sdk/openapi.json`.
 * Routes are declared statically, so no database is needed; handlers never run. The output is
 * formatted with the repository's prettier settings so `pnpm generate` and `pnpm format` agree.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DbClient } from '@agon/db';
import pino from 'pino';
import { format, resolveConfig as resolvePrettierConfig } from 'prettier';
import { createApp } from './app.js';
import type { AppContext } from './context.js';
import { buildOpenApiDocument, packageVersion } from './openapi.js';
import { resolveConfig } from './server.js';

/** A context whose runtime services throw if touched: only route declarations are exercised. */
function documentationContext(): AppContext {
  const unavailable = (what: string) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(`${what} is not available while exporting the OpenAPI document`);
        },
      },
    );
  return {
    db: unavailable('database') as DbClient,
    logger: pino({ level: 'silent' }),
    config: resolveConfig({ databaseUrl: 'postgres://unused' }),
    version: packageVersion(),
    queue: unavailable('queue') as AppContext['queue'],
    control: unavailable('control sender') as AppContext['control'],
    webhooks: unavailable('webhooks') as AppContext['webhooks'],
    stats: unavailable('stats') as AppContext['stats'],
    runDependencies: () => {
      throw new Error('run dependencies are not available while exporting the OpenAPI document');
    },
  };
}

/** The document as `pnpm generate` writes it. */
export function openApiDocument(): Record<string, unknown> {
  const ctx = documentationContext();
  return buildOpenApiDocument(createApp(ctx), ctx.version);
}

const outPath = process.argv[2];
if (!outPath) {
  process.stderr.write('usage: export-openapi <outPath>\n');
  process.exit(2);
}
const target = resolve(outPath);
mkdirSync(dirname(target), { recursive: true });
const prettierOptions = (await resolvePrettierConfig(target)) ?? {};
const formatted = await format(JSON.stringify(openApiDocument()), {
  ...prettierOptions,
  parser: 'json',
});
writeFileSync(target, formatted);
process.stdout.write(`wrote ${target}\n`);
