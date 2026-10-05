import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createDbRecorder, runs, sessions } from '@agon/db';
import { runExperiment } from '@agon/engine';
import { createExporters } from '@agon/exporters';
import {
  ConfigError,
  type ExportConfig,
  type Recorder,
  type Result,
  type Run,
  type Session,
} from '@agon/spec';
import { buildAnalysisConfig } from '@agon/stats-client';
import type { Logger } from 'pino';
import type { AppContext } from '../context.js';
import { evaluatePolicies } from '../policies.js';
import type { RunJobData } from '../queue.js';
import {
  composeRecorders,
  createExporterRecorder,
  createProgressRecorder,
  createScreenshotRecorder,
} from './recorders.js';
import { updateSquadScores } from './scoring.js';

export const CANCEL_POLL_MS = 2_000;

/** `<dataDir>/screenshots`, `<dataDir>/runs/<runId>/`, `<dataDir>/exports`. */
export function dataPaths(dataDir: string) {
  return {
    screenshots: join(dataDir, 'screenshots'),
    runDir: (runId: string) => join(dataDir, 'runs', runId),
    exports: join(dataDir, 'exports'),
  };
}

/** Relative file-sink paths in `export:` are taken relative to `<dataDir>/exports`. */
export function resolveExportPaths(
  configs: readonly ExportConfig[],
  exportsDir: string,
): ExportConfig[] {
  return configs.map((c) => {
    if ((c.type === 'jsonl' || c.type === 'parquet') && !isAbsolute(c.path)) {
      return { ...c, path: resolve(exportsDir, c.path) };
    }
    return c;
  });
}

/** Every session of a run, across pages, in index order. */
export async function listAllSessions(ctx: AppContext, runId: string): Promise<Session[]> {
  const out: Session[] = [];
  let cursor: string | undefined;
  do {
    const page = await sessions.listByRun(ctx.db, runId, { limit: 1000, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Writes `sessions.jsonl` (one spec Session per line) for the stats engine; returns the path. */
export async function writeSessionsJsonl(dir: string, list: readonly Session[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'sessions.jsonl');
  const handle = await open(path, 'w');
  try {
    for (const session of list) await handle.write(`${JSON.stringify(session)}\n`);
  } finally {
    await handle.close();
  }
  return path;
}

/** Polls the run row and aborts the controller once it is cancelled. */
function watchForCancel(ctx: AppContext, runId: string, controller: AbortController, log: Logger) {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    runs
      .find(ctx.db, runId)
      .then((run) => {
        if (run?.status === 'cancelled') {
          log.info('cancellation requested; finishing in-flight sessions');
          controller.abort();
        }
      })
      .catch((error: unknown) => log.warn({ err: error }, 'cancel poll failed'))
      .finally(() => {
        inFlight = false;
      });
  }, CANCEL_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Exports the run's sessions and runs the stats engine. Stores nothing; the caller does. */
async function analyze(ctx: AppContext, run: Run, log: Logger): Promise<Result> {
  const paths = dataPaths(ctx.config.dataDir);
  const list = await listAllSessions(ctx, run.id);
  const dir = paths.runDir(run.id);
  const sessionsPath = await writeSessionsJsonl(dir, list);
  const analysis = buildAnalysisConfig(run.config, { id: run.id, seed: run.seed });
  const result = await ctx.stats.analyze({
    sessionsPath,
    analysis,
    outPath: join(dir, 'result.json'),
  });
  log.info(
    { resultId: result.id, verdict: result.decision.verdict, sessions: list.length },
    'analysis done',
  );
  return result;
}

/**
 * Executes one queued run end to end: simulate, persist, export, analyze, score squads, evaluate
 * policies, notify. Idempotent for runs that are no longer `queued`.
 *
 * The analysis happens inside the engine's `runFinished` hook, so the run row turns `completed`
 * in the same transaction that stores its Result: a client that sees `completed` can fetch the
 * result right away (or read `error` to learn why there is none).
 */
export async function processRun(ctx: AppContext, data: RunJobData): Promise<void> {
  const log = ctx.logger.child({ runId: data.runId });
  const queued = await runs.find(ctx.db, data.runId);
  if (!queued) {
    log.warn('run no longer exists; dropping job');
    return;
  }
  if (queued.status !== 'queued') {
    log.info({ status: queued.status }, 'run is not queued; dropping job');
    return;
  }
  const run = await runs.setStatus(ctx.db, queued.id, 'running');
  const config = run.config;
  const paths = dataPaths(ctx.config.dataDir);
  const controller = new AbortController();
  const stopWatching = watchForCancel(ctx, run.id, controller, log);

  const exporter = createExporters(resolveExportPaths(config.export, paths.exports), {
    runId: run.id,
    experimentName: config.name,
    logger: log,
  });
  let result: Result | undefined;
  const dbRecorder = createDbRecorder(ctx.db);
  const finalizingRecorder: Recorder = {
    ...dbRecorder,
    async runFinished(finished: Run) {
      let row = finished;
      if (finished.status === 'completed' && !data.dryRun) {
        try {
          result = await analyze(ctx, finished, log);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          log.error({ err: error }, 'analysis failed; run completes without a result');
          row = { ...finished, error: `analysis failed: ${reason}` };
        }
      }
      await dbRecorder.runFinished(row, result);
    },
  };
  const recorder = composeRecorders(
    finalizingRecorder,
    createProgressRecorder(ctx.db),
    createScreenshotRecorder(paths.screenshots),
    createExporterRecorder(exporter),
  );

  let deps: Awaited<ReturnType<AppContext['runDependencies']>> | undefined;
  let finalRun: Run = run;
  let finishedSessions: Session[] = [];
  try {
    if (config.target.kind !== 'web') {
      throw new ConfigError(
        `target kind "${config.target.kind}" is not supported yet; only "web" targets run`,
      );
    }
    deps = await ctx.runDependencies({ run, logger: log });
    const outcome = await runExperiment(
      config,
      {
        runId: run.id,
        environmentId: run.environmentId,
        variants: run.variants,
        seed: run.seed,
        dryRun: data.dryRun ?? false,
        concurrency: ctx.config.concurrency,
      },
      {
        llm: deps.llm,
        adapters: { web: deps.adapter },
        recorder,
        logger: log,
        cwd: ctx.config.dataDir,
        signal: controller.signal,
      },
    );
    finishedSessions = outcome.sessions;
    finalRun = await runs.get(ctx.db, run.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'run failed');
    finalRun = await runs.setStatus(ctx.db, run.id, 'failed', { error: reason });
  } finally {
    stopWatching();
    try {
      await exporter.runFinished(finalRun, result);
      await exporter.close();
    } catch (error) {
      log.warn({ err: error }, 'export failed');
    }
    try {
      await deps?.dispose?.();
    } catch (error) {
      log.warn({ err: error }, 'disposing run dependencies failed');
    }
  }

  if (result) {
    const stored = result;
    await safely(log, 'squad scoring', () =>
      updateSquadScores(ctx.db, finalRun, stored, finishedSessions, log),
    );
    await ctx.webhooks.emit('result.ready', { run: finalRun, result: stored });
    await safely(log, 'policies(result.ready)', () =>
      evaluatePolicies(ctx, { trigger: 'result.ready', run: finalRun, result: stored }),
    );
  }
  await ctx.webhooks.emit('run.completed', {
    run: finalRun,
    ...(result ? { resultId: result.id } : {}),
  });
  if (finalRun.status === 'completed') {
    await safely(log, 'policies(run.completed)', () =>
      evaluatePolicies(ctx, { trigger: 'run.completed', run: finalRun, result }),
    );
  }
  log.info(
    { status: finalRun.status, counts: finalRun.counts, resultId: finalRun.resultId },
    'run processed',
  );
}

async function safely(log: Logger, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.error({ err: error }, `${what} failed`);
  }
}

/** Subscribes the run worker to the queue. */
export async function registerRunWorker(ctx: AppContext): Promise<void> {
  await ctx.queue.work(async (data) => {
    try {
      await processRun(ctx, data);
    } catch (error) {
      // processRun records failures on the run; anything reaching here is a bug worth logging,
      // but not worth a pg-boss retry that would re-run the experiment.
      ctx.logger.error({ err: error, runId: data.runId }, 'run worker crashed');
    }
  });
  ctx.logger.info('run worker registered');
}
