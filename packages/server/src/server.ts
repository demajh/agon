import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb, migrate, type DbClient } from '@agon/db';
import { serve, type ServerType } from '@hono/node-server';
import pino, { type Logger } from 'pino';
import { createApp, type AgonApp } from './app.js';
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  roleIncludesApi,
  roleIncludesWorker,
  type ServerConfig,
} from './config.js';
import type { AppContext } from './context.js';
import { packageVersion } from './openapi.js';
import { createRunQueue } from './queue.js';
import { createControlSender } from './squads/control.js';
import { createWebhookEmitter, type FetchLike } from './webhooks.js';
import {
  defaultRunDependencies,
  defaultStatsClient,
  type RunDependenciesFactory,
  type StatsClient,
} from './worker/deps.js';
import { registerRunWorker } from './worker/run-worker.js';

export interface CreateServerOptions {
  /** `databaseUrl` is required; everything else falls back to the defaults `main.ts` uses. */
  config: Partial<ServerConfig> & Pick<ServerConfig, 'databaseUrl'>;
  logger?: Logger | undefined;
  /** Replaces the live model client and Chromium (tests use `@agon/engine/fakes`). */
  runDependencies?: RunDependenciesFactory | undefined;
  /** Replaces the `agon-stats` subprocess. */
  stats?: StatsClient | undefined;
  /** Used for control messages and outbound webhooks. */
  fetch?: FetchLike | undefined;
  /** Seconds between queue polls when idle (default 2; tests lower it). */
  queuePollingIntervalSeconds?: number | undefined;
  /** Listen on `config.port`; false runs the API only through `app.request()` (tests). */
  listen?: boolean | undefined;
}

export interface AgonServer {
  app: AgonApp;
  db: DbClient;
  context: AppContext;
  /** Migrates the database, starts the queue and worker, and listens. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The bound port once listening. */
  readonly port: number | undefined;
  readonly url: string | undefined;
}

export function resolveConfig(partial: CreateServerOptions['config']): ServerConfig {
  return {
    databaseUrl: partial.databaseUrl,
    port: partial.port ?? DEFAULT_PORT,
    host: partial.host ?? '0.0.0.0',
    role: partial.role ?? 'all',
    bootstrapKeys: partial.bootstrapKeys ?? [],
    dataDir: resolve(partial.dataDir ?? DEFAULT_DATA_DIR),
    llmMode: partial.llmMode,
    webhookUrl: partial.webhookUrl,
    logLevel: partial.logLevel ?? 'info',
    queueSchema: partial.queueSchema ?? 'pgboss',
    concurrency: partial.concurrency,
  };
}

export function createServer(options: CreateServerOptions): AgonServer {
  const config = resolveConfig(options.config);
  const logger = options.logger ?? pino({ level: config.logLevel });
  const handle = createDb(config.databaseUrl, { pool: { max: 10 } });
  const queue = createRunQueue({
    connectionString: config.databaseUrl,
    schema: config.queueSchema,
    logger: logger.child({ component: 'queue' }),
    pollingIntervalSeconds: options.queuePollingIntervalSeconds,
  });
  const context: AppContext = {
    db: handle.db,
    logger,
    config,
    version: packageVersion(),
    queue,
    control: createControlSender({ logger, fetch: options.fetch }),
    webhooks: createWebhookEmitter({ url: config.webhookUrl, logger, fetch: options.fetch }),
    stats: options.stats ?? defaultStatsClient(),
    runDependencies: options.runDependencies ?? defaultRunDependencies({ llmMode: config.llmMode }),
  };
  const app = createApp(context);

  let httpServer: ServerType | undefined;
  let port: number | undefined;
  let started = false;

  return {
    app,
    db: handle.db,
    context,
    get port() {
      return port;
    },
    get url() {
      return port === undefined
        ? undefined
        : `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
    },
    async start() {
      if (started) return;
      started = true;
      await mkdir(config.dataDir, { recursive: true });
      await migrate(handle.db);
      logger.info({ role: config.role, dataDir: config.dataDir }, 'database migrated');
      await queue.start();
      if (roleIncludesWorker(config.role)) await registerRunWorker(context);
      if (roleIncludesApi(config.role) && (options.listen ?? true)) {
        await new Promise<void>((resolveListen) => {
          httpServer = serve(
            { fetch: app.fetch, port: config.port, hostname: config.host },
            (info) => {
              port = info.port;
              resolveListen();
            },
          );
        });
        logger.info({ port, host: config.host, version: context.version }, 'agon server listening');
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      if (httpServer) {
        const server = httpServer;
        httpServer = undefined;
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        port = undefined;
      }
      await queue.stop();
      await handle.close();
      logger.info('agon server stopped');
    },
  };
}
