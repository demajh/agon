import { PgBoss, type Job } from 'pg-boss';
import type { Logger } from 'pino';

export const RUN_QUEUE = 'agon.run';

/** Payload of an `agon.run` job. The run row holds everything else. */
export interface RunJobData {
  runId: string;
  dryRun?: boolean;
}

export type RunJobHandler = (data: RunJobData, job: Job<RunJobData>) => Promise<void>;

export interface RunQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueRun(data: RunJobData): Promise<string | null>;
  /** Registers the worker; jobs are processed one at a time per process. */
  work(handler: RunJobHandler): Promise<void>;
  /** Deletes every queued and stored job (tests). */
  clear(): Promise<void>;
}

export interface RunQueueOptions {
  connectionString: string;
  schema?: string | undefined;
  logger: Logger;
  /** Seconds between polls when idle (default 2). */
  pollingIntervalSeconds?: number | undefined;
  /** Seconds a run may stay active before pg-boss gives up on it (default 24 h). */
  expireInSeconds?: number | undefined;
  /** How long `stop()` waits for in-flight jobs (default 30 s). */
  stopTimeoutMs?: number | undefined;
}

export function createRunQueue(options: RunQueueOptions): RunQueue {
  const { logger } = options;
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? 'pgboss',
    application_name: 'agon-server',
    // Keep the instance registry and queue monitors quiet in small deployments and tests.
    registerInstance: false,
    monitorVacuum: false,
  });
  boss.on('error', (error) => logger.error({ err: error }, 'pg-boss error'));
  boss.on('warning', (warning) => logger.warn({ warning }, 'pg-boss warning'));
  let started = false;

  const ensureQueue = async (): Promise<void> => {
    const existing = await boss.getQueue(RUN_QUEUE);
    if (existing) return;
    await boss.createQueue(RUN_QUEUE, {
      retryLimit: 0,
      expireInSeconds: options.expireInSeconds ?? 24 * 3600,
    });
  };

  return {
    async start() {
      if (started) return;
      await boss.start();
      await ensureQueue();
      started = true;
      logger.debug({ queue: RUN_QUEUE }, 'queue started');
    },
    async stop() {
      if (!started) return;
      started = false;
      // Let an in-flight run finish its current step before the pool closes; a run that outlives
      // the timeout is interrupted and stays `running` until an operator cancels it.
      await boss.stop({ graceful: true, close: true, timeout: options.stopTimeoutMs ?? 30_000 });
    },
    async enqueueRun(data) {
      return boss.send(RUN_QUEUE, data, { singletonKey: data.runId });
    },
    async work(handler) {
      await boss.work<RunJobData>(
        RUN_QUEUE,
        {
          batchSize: 1,
          pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
        },
        async (jobs) => {
          for (const job of jobs) {
            await handler(job.data, job);
          }
        },
      );
    },
    async clear() {
      await boss.deleteAllJobs(RUN_QUEUE);
    },
  };
}
