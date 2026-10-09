import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AgonError,
  ConfigError,
  ErrorCodes,
  ResultSchema,
  ValidationError,
  controlVariant,
  requirementsDigest,
  type AgonConfig,
  type Analysis,
  type Metric,
  type Result,
} from '@agon/spec';
import { z } from 'zod';
import { resolveStatsBinary, type StatsBinary } from './binary.js';

const execFileAsync = promisify(execFile);

/** The `analysis.json` document `agon-stats analyze --config` reads. */
export interface AnalysisConfig {
  runId: string;
  control: string;
  method: Analysis['method'];
  minSessionsPerVariant: number;
  decision: Analysis['decision'];
  alpha: number;
  clusterBy: Analysis['clusterBy'];
  calibrationProfile: string;
  seed: number;
  metrics: Metric[];
  changeCategory?: string;
  /** M from the evaluation ledger: distinct variants ever evaluated against the sample. */
  trials?: number;
  sampleHash?: string;
  /**
   * Hash of the requirements the result is accepted under (analysis section with its materiality
   * boundary, metrics, policies); agon-stats stamps it on the Result as `requirementsDigest`.
   */
  requirementsDigest: string;
}

export interface AnalysisOverrides {
  method?: Analysis['method'] | undefined;
  control?: string | undefined;
  minSessionsPerVariant?: number | undefined;
  calibrationProfile?: string | undefined;
  changeCategory?: string | undefined;
  seed?: number | undefined;
  trials?: number | undefined;
  sampleHash?: string | undefined;
}

/** Derives the analysis config from an agon.yaml and a run's id/seed, with CLI/API overrides. */
export function buildAnalysisConfig(
  config: AgonConfig,
  run: { id: string; seed: number },
  overrides: AnalysisOverrides = {},
): AnalysisConfig {
  const control = overrides.control ?? controlVariant(config);
  if (!config.target.variants[control]) {
    throw new ConfigError(
      `control "${control}" is not one of the variants: ${Object.keys(config.target.variants).join(', ')}`,
    );
  }
  // The receipt names the requirements the result is actually accepted under: the config's
  // analysis section with every override that changes the decision applied.
  const effective: Analysis = {
    ...config.analysis,
    ...(overrides.method === undefined ? {} : { method: overrides.method }),
    ...(overrides.control === undefined ? {} : { control: overrides.control }),
    ...(overrides.minSessionsPerVariant === undefined
      ? {}
      : { minSessionsPerVariant: overrides.minSessionsPerVariant }),
    ...(overrides.calibrationProfile === undefined
      ? {}
      : { calibrationProfile: overrides.calibrationProfile }),
  };
  return {
    runId: run.id,
    control,
    method: overrides.method ?? config.analysis.method,
    minSessionsPerVariant: overrides.minSessionsPerVariant ?? config.analysis.minSessionsPerVariant,
    decision: config.analysis.decision,
    alpha: config.analysis.alpha,
    clusterBy: config.analysis.clusterBy,
    calibrationProfile: overrides.calibrationProfile ?? config.analysis.calibrationProfile,
    seed: overrides.seed ?? run.seed,
    metrics: config.metrics,
    requirementsDigest: requirementsDigest({ ...config, analysis: effective }),
    ...(overrides.changeCategory === undefined ? {} : { changeCategory: overrides.changeCategory }),
    ...(overrides.trials === undefined ? {} : { trials: overrides.trials }),
    ...(overrides.sampleHash === undefined ? {} : { sampleHash: overrides.sampleHash }),
  };
}

export interface StatsRunOptions {
  binary?: StatsBinary | undefined;
  timeoutMs?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
}

const StatsErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

function toAgonError(stderr: string, fallback: string): AgonError {
  const trimmed = stderr.trim();
  const lastLine = trimmed.split('\n').filter(Boolean).at(-1) ?? '';
  const parsed = StatsErrorSchema.safeParse(safeJson(lastLine));
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    if (code === ErrorCodes.CONFIG) return new ConfigError(`agon-stats: ${message}`);
    if (code === ErrorCodes.VALIDATION) return new ValidationError(`agon-stats: ${message}`);
    return new AgonError(ErrorCodes.INTERNAL, `agon-stats: ${message}`, { details: { code } });
  }
  return new AgonError(
    ErrorCodes.INTERNAL,
    `${fallback}${trimmed ? `\n${trimmed.slice(-2000)}` : ''}`,
  );
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function runStats(args: string[], options: StatsRunOptions): Promise<string> {
  const binary = options.binary ?? resolveStatsBinary({ env: options.env });
  try {
    const { stdout } = await execFileAsync(binary.command, [...binary.args, ...args], {
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...options.env },
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; code?: unknown; message?: string };
    throw toAgonError(
      e.stderr ?? '',
      `agon-stats failed (${String(e.code ?? e.message ?? 'unknown error')})`,
    );
  }
}

export interface AnalyzeInput {
  /** Path to sessions.jsonl / .json / .parquet. */
  sessionsPath: string;
  analysis: AnalysisConfig;
  /** Where to write result.json; also returned. Defaults to a temp directory. */
  outPath?: string | undefined;
  resultId?: string | undefined;
}

/** Runs `agon-stats analyze` and returns the validated Result. */
export async function analyzeSessions(
  input: AnalyzeInput,
  options: StatsRunOptions = {},
): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'agon-stats-'));
  const configPath = join(dir, 'analysis.json');
  writeFileSync(configPath, JSON.stringify(input.analysis, null, 2));
  const args = ['analyze', '--sessions', input.sessionsPath, '--config', configPath];
  if (input.resultId) args.push('--result-id', input.resultId);
  const stdout = await runStats(args, options);
  const parsed = ResultSchema.safeParse(safeJson(stdout.trim()));
  if (!parsed.success) {
    throw new AgonError(
      ErrorCodes.INTERNAL,
      `agon-stats returned an invalid Result:\n${z.prettifyError(parsed.error)}`,
      {
        details: { stdout: stdout.slice(0, 2000) },
      },
    );
  }
  if (input.outPath) writeFileSync(input.outPath, JSON.stringify(parsed.data, null, 2));
  return parsed.data;
}

export interface SquadScoreInput {
  squad: string;
  wins: number;
  runs: number;
}

const AllocationSchema = z.object({ allocation: z.record(z.string(), z.number()) });

/** Thompson-sampling allocation over squads with a per-squad floor. */
export async function allocateSquads(
  scores: SquadScoreInput[],
  options: StatsRunOptions & { floor?: number | undefined; seed?: number | undefined } = {},
): Promise<Record<string, number>> {
  const args = ['allocate', '--scores', JSON.stringify(scores)];
  if (options.floor !== undefined) args.push('--floor', String(options.floor));
  if (options.seed !== undefined) args.push('--seed', String(options.seed));
  const stdout = await runStats(args, options);
  const parsed = AllocationSchema.safeParse(safeJson(stdout.trim()));
  if (!parsed.success)
    throw new AgonError(ErrorCodes.INTERNAL, 'agon-stats allocate returned an invalid allocation', {
      details: { stdout },
    });
  return parsed.data.allocation;
}

export async function statsVersion(options: StatsRunOptions = {}): Promise<string> {
  return (await runStats(['--version'], options)).trim();
}
