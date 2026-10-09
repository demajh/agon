import {
  ConfigError,
  ID_PREFIXES,
  isAgonError,
  newId,
  nowIso,
  type Adapter,
  type AgonConfig,
  type ErrorCode,
  type LlmClient,
  type PartialDeltaManifest,
  type Recorder,
  type Run,
  type RunFailure,
  type RunTermination,
  type RunTerminationKind,
  type Session,
  type TargetKind,
} from '@agon/spec';
import pino, { type Logger } from 'pino';
import type { PatienceParams } from '../agent/patience.js';
import { resolvePersonas, type ResolvePersonaOptions } from '../population/personas.js';
import { planSessions, type SessionPlan } from '../population/sampler.js';
import { TIME_CAP_STOP_REASON, runSession, type SessionResult } from '../session/runner.js';

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
  /** Cancels the run: no new sessions start and the ones in flight stop between steps. */
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
  /** Wall-clock cap for the whole run; default `defaults.timeCapMs`. */
  timeCapMs?: number | undefined;
  /**
   * When the run's clock started (ISO-8601); default now. A server passes the time the run was
   * queued so that queue time and cold start count against the cap.
   */
  startedAt?: string | undefined;
}

export interface RunOutcome {
  run: Run;
  plans: SessionPlan[];
  sessions: Session[];
  results: SessionResult[];
  termination: RunTermination;
}

/** Node timers overflow above this many ms; longer caps are re-armed in slices. */
const MAX_TIMER_MS = 2_147_483_647;

interface ClassifiedFailure extends RunFailure {
  code: ErrorCode | undefined;
}

/** A failure the product cannot have caused: the adapter, target or model provider broke. */
function isInfraFailure(failure: ClassifiedFailure): boolean {
  return (
    failure.code === 'adapter_error' ||
    failure.code === 'llm_error' ||
    failure.location === 'adapter open'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function partialManifest(
  variants: readonly string[],
  results: readonly SessionResult[],
): PartialDeltaManifest {
  const sessionsPerVariant: Record<string, number> = Object.fromEntries(
    variants.map((v) => [v, 0]),
  );
  const metrics = new Set<string>();
  for (const { session } of results) {
    if (session.status !== 'finished') continue;
    sessionsPerVariant[session.variant] = (sessionsPerVariant[session.variant] ?? 0) + 1;
    for (const id of Object.keys(session.metrics)) metrics.add(id);
  }
  return { sessionsPerVariant, metricsComputed: [...metrics].sort(), exportsWritten: [] };
}

/** Expands a config into sessions, runs them with bounded concurrency, and records the run. */
export async function runExperiment(
  config: AgonConfig,
  options: RunOptions,
  deps: RunDeps,
): Promise<RunOutcome> {
  const logger = deps.logger ?? pino({ level: process.env['AGON_LOG_LEVEL'] ?? 'info' });
  const cwd = deps.cwd ?? process.cwd();
  const clockStart = options.startedAt === undefined ? Date.now() : Date.parse(options.startedAt);
  if (Number.isNaN(clockStart)) throw new ConfigError(`invalid startedAt: ${options.startedAt}`);
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
  const timeCapMs = options.timeCapMs ?? effectiveConfig.defaults.timeCapMs;
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
    counts: { planned: plans.length, running: 0, completed: 0, failed: 0, interrupted: 0 },
    costUsd: 0,
    createdAt: nowIso(),
    startedAt: new Date(clockStart).toISOString(),
  };
  const log = logger.child({ runId });
  await deps.recorder.runStarted(run);
  const termination = (
    kind: RunTerminationKind,
    extra: Partial<RunTermination> = {},
  ): RunTermination => ({
    kind,
    elapsedMs: Math.max(0, Date.now() - clockStart),
    capMs: timeCapMs,
    lastCompletedStage: 'sessions',
    sessionsExecuted: run.counts.completed + run.counts.failed,
    sessionsPlanned: plans.length,
    failureCount: run.counts.failed,
    ...extra,
  });
  if (options.dryRun) {
    run.termination = termination('completed', { lastCompletedStage: 'setup' });
    run.finishedAt = nowIso();
    await deps.recorder.runFinished(run);
    return { run, plans, sessions: [], results: [], termination: run.termination };
  }

  // The time cap: counted from clockStart, so queue time and setup are inside it. Reaching it
  // aborts the shared signal with TIME_CAP_STOP_REASON; the runner tells it apart from a cancel.
  const cap = new AbortController();
  let capTimer: NodeJS.Timeout | undefined;
  const armCap = (): void => {
    const remaining = clockStart + timeCapMs - Date.now();
    if (remaining <= 0) {
      cap.abort(TIME_CAP_STOP_REASON);
      return;
    }
    capTimer = setTimeout(
      remaining > MAX_TIMER_MS ? armCap : () => cap.abort(TIME_CAP_STOP_REASON),
      Math.min(remaining, MAX_TIMER_MS),
    );
  };
  const signal =
    deps.signal === undefined ? cap.signal : AbortSignal.any([deps.signal, cap.signal]);

  const concurrency = Math.max(1, options.concurrency ?? effectiveConfig.defaults.maxConcurrency);
  const timeoutMs = deps.sessionTimeoutMs ?? 15 * 60_000;
  const results: SessionResult[] = [];
  const failures: ClassifiedFailure[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < plans.length) {
      if (signal.aborted) return;
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
              signal,
            },
          ),
          timeoutMs,
          `session ${plan.sessionId} exceeded ${timeoutMs}ms`,
        );
        results.push(result);
        run.costUsd += result.session.costUsd;
        if (result.interruptedBy !== undefined) run.counts.interrupted++;
        else if (result.session.status === 'failed') {
          run.counts.failed++;
          failures.push({
            id: plan.sessionId,
            location: result.failure?.location ?? 'session',
            message: result.session.error ?? 'session failed',
            code: result.failure?.code,
          });
        } else run.counts.completed++;
      } catch (error) {
        run.counts.failed++;
        failures.push({
          id: plan.sessionId,
          location: 'session',
          message: errorMessage(error),
          code: isAgonError(error) ? error.code : undefined,
        });
        log.error({ err: error, sessionId: plan.sessionId }, 'session crashed');
      } finally {
        run.counts.running--;
      }
    }
  };
  try {
    armCap();
    await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, () => worker()));
  } finally {
    clearTimeout(capTimer);
  }

  const capReached = cap.signal.aborted;
  const cancelled = deps.signal?.aborted === true;
  const first = failures[0];
  let kind: RunTerminationKind;
  if (cancelled) kind = 'cancelled';
  else if (run.counts.completed === 0 && run.counts.failed > 0)
    kind = first !== undefined && isInfraFailure(first) ? 'infra_aborted' : 'failed';
  else if (capReached) kind = 'time_cap_reached';
  else kind = 'completed';

  run.status =
    kind === 'cancelled'
      ? 'cancelled'
      : kind === 'completed' || kind === 'time_cap_reached'
        ? 'completed'
        : 'failed';
  if (run.status === 'failed') run.error = 'every session failed';
  run.termination = termination(kind, {
    ...(kind === 'time_cap_reached' || kind === 'cancelled'
      ? { partialDeltaManifest: partialManifest(variants, results) }
      : {}),
    ...(first === undefined
      ? {}
      : { firstFailure: { id: first.id, location: first.location, message: first.message } }),
  });
  run.finishedAt = nowIso();
  await deps.recorder.runFinished(run);
  log.info(
    {
      status: run.status,
      termination: run.termination.kind,
      counts: run.counts,
      costUsd: run.costUsd,
    },
    'run finished',
  );
  return {
    run,
    plans,
    sessions: results.map((r) => r.session),
    results,
    termination: run.termination,
  };
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
