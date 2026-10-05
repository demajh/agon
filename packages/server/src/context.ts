import type { DbClient } from '@agon/db';
import type { Logger } from 'pino';
import type { ServerConfig } from './config.js';
import type { RunQueue } from './queue.js';
import type { ControlSender } from './squads/control.js';
import type { WebhookEmitter } from './webhooks.js';
import type { RunDependenciesFactory, StatsClient } from './worker/deps.js';

/** Everything route handlers and workers share. Built once by `createServer`. */
export interface AppContext {
  db: DbClient;
  logger: Logger;
  config: ServerConfig;
  version: string;
  queue: RunQueue;
  control: ControlSender;
  webhooks: WebhookEmitter;
  stats: StatsClient;
  runDependencies: RunDependenciesFactory;
}
