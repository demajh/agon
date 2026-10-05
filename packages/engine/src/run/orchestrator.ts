import {
  ConfigError,
  ID_PREFIXES,
  newId,
  nowIso,
  type Adapter,
  type AgonConfig,
  type LlmClient,
  type Recorder,
  type Run,
  type Session,
  type TargetKind,
} from '@agon/spec';
import pino, { type Logger } from 'pino';
import type { PatienceParams } from '../agent/patience.js';
import { resolvePersonas, type ResolvePersonaOptions } from '../population/personas.js';
import { planSessions, type SessionPlan } from '../population/sampler.js';
import { runSession, type SessionResult } from '../session/runner.js';

export interface RunDeps {
  llm: LlmClient;
  adapters: Partial<Record<TargetKind, Adapter>>;
  recorder: Recorder;
  logger?: Logger | undefined;
  /** Base directory for hooks and relative persona paths. */
  cwd?: string | undefined;
  personas?: ResolvePersonaOptions | undefined;
  patience?: PatienceParams | undefined;
  cacheDecisions?: boolean | undefined;
  signal?: AbortSignal | undefined;
  /** Hard cap per session, in ms. Default 15 minutes. */
  sessionTimeoutMs?: number | undefined;
}

export interface RunOptions {
  runId?: string | undefined;
  environmentId?: string | undefined;
  variants?: readonly string[] | undefined;
  seed?: number | undefined;
  size?: number | undefined;
  model?: string | undefined;
  dryRun?: boolean | undefined;
  concurrency?: number | undefined;
}

export interface RunOutcome {
  run: Run;
  plans: SessionPlan[];
  sessions: Session[];
  results: SessionResult[];
}

/** Expands a config into sessions, runs them with bounded concurrency, and records the run. */
export async function runExperiment(
  config: AgonConfig,
  options: RunOptions,
  deps: RunDeps,
): Promise<RunOutcome> {
  const logger = deps.logger ?? pino({ level: process.env['AGON_LOG_LEVEL'] ?? 'info' });
  const cwd = deps.cwd ?? process.cwd();
  const variants = options.variants ?? Object.keys(config.target.variants);
  for (const v of variants) {
    if (!config.target.variants[v])
      throw new ConfigError(
        `unknown variant "${v}" (have: ${Object.keys(config.target.variants).join(', ')})`,
      );
  }
  const adapter = deps.adapters[config.target.kind];
  if (!adapter)
    throw new ConfigError(`no adapter registered for target kind "${config.target.kind}"`);

  const runId = options.runId ?? newId(ID_PREFIXES.run);
  const seed = options.seed ?? config.population.seed;
  const size = options.size ?? config.population.size;
  const effectiveConfig: AgonConfig =
    options.model === undefined
      ? config
      : { ...config, defaults: { ...config.defaults, model: options.model } };
  const personas = resolvePersonas(effectiveConfig, { cwd, ...deps.personas });
  const plans = planSessions(effectiveConfig, personas, {
    runId,
    variants,
    seed,
    size,
    defaultModel: effectiveConfig.defaults.model,
  });

  const run: Run = {
    id: runId,
    environmentId: options.environmentId ?? `env_${effectiveConfig.name}`,
    status: options.dryRun ? 'completed' : 'running',
    variants: [...variants],
    seed,
    config: effectiveConfig,
    counts: { planned: plans.length, running: 0, completed: 0, failed: 0 },
    costUsd: 0,
    createdAt: nowIso(),
    startedAt: nowIso(),
  };
  const log = logger.child({ runId });
  await deps.recorder.runStarted(run);
  if (options.dryRun) {
    run.finishedAt = nowIso();
    await deps.recorder.runFinished(run);
    return { run, plans, sessions: [], results: [] };
  }

  const concurrency = Math.max(1, options.concurrency ?? effectiveConfig.defaults.maxConcurrency);
  const timeoutMs = deps.sessionTimeoutMs ?? 15 * 60_000;
  const results: SessionResult[] = [];
  let cursor = 0;
  let cancelled = false;

  const worker = async (): Promise<void> => {
    while (cursor < plans.length) {
      if (deps.signal?.aborted) {
        cancelled = true;
        return;
      }
      const plan = plans[cursor++] as SessionPlan;
      run.counts.running++;
      try {
        const result = await withTimeout(
          runSession(
            {
              runId,
              config: effectiveConfig,
              plan,
              variantSpec: effectiveConfig.target.variants[plan.variant]!,
            },
            {
              llm: deps.llm,
              adapter,
              recorder: deps.recorder,
              logger: log,
              cwd,
              patience: deps.patience,
              cacheDecisions: deps.cacheDecisions,
            },
          ),
          timeoutMs,
          `session ${plan.sessionId} exceeded ${timeoutMs}ms`,
        );
        results.push(result);
        run.costUsd += result.session.costUsd;
        if (result.session.status === 'failed') run.counts.failed++;
        else run.counts.completed++;
      } catch (error) {
        run.counts.failed++;
        log.error({ err: error, sessionId: plan.sessionId }, 'session crashed');
      } finally {
        run.counts.running--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, () => worker()));

  run.status = cancelled
    ? 'cancelled'
    : run.counts.completed === 0 && plans.length > 0
      ? 'failed'
      : 'completed';
  if (run.status === 'failed') run.error = 'every session failed';
  run.finishedAt = nowIso();
  await deps.recorder.runFinished(run);
  log.info({ status: run.status, counts: run.counts, costUsd: run.costUsd }, 'run finished');
  return { run, plans, sessions: results.map((r) => r.session), results };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
