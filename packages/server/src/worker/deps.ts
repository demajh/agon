import { createWebAdapter } from '@agon/adapters';
import { createLlmClient, type LlmMode } from '@agon/llm';
import type { Adapter, LlmClient, Result, Run } from '@agon/spec';
import {
  allocateSquads,
  analyzeSessions,
  type AnalyzeInput,
  type SquadScoreInput,
} from '@agon/stats-client';
import type { Logger } from 'pino';

/** What a run needs besides the database: the model client and the target adapter. */
export interface RunDependencies {
  llm: LlmClient;
  adapter: Adapter;
  /** Called once the run is over, whatever its outcome. */
  dispose?: (() => Promise<void>) | undefined;
}

export interface RunDependenciesInput {
  run: Run;
  logger: Logger;
}

/** Builds the dependencies for one run. Tests inject `@agon/engine/fakes` here. */
export type RunDependenciesFactory = (
  input: RunDependenciesInput,
) => Promise<RunDependencies> | RunDependencies;

export interface DefaultRunDependenciesOptions {
  llmMode?: LlmMode | undefined;
  llmCacheDir?: string | undefined;
  headless?: boolean | undefined;
}

/** Live model client (mode from `AGON_LLM_MODE`) and a fresh Chromium per run. */
export function defaultRunDependencies(
  options: DefaultRunDependenciesOptions = {},
): RunDependenciesFactory {
  return ({ logger }) => {
    const llm = createLlmClient({
      ...(options.llmMode === undefined ? {} : { mode: options.llmMode }),
      ...(options.llmCacheDir === undefined ? {} : { cacheDir: options.llmCacheDir }),
      logger,
    });
    const adapter = createWebAdapter({ headless: options.headless ?? true });
    return { llm, adapter, dispose: () => adapter.dispose() };
  };
}

export interface AllocateOptions {
  floor?: number | undefined;
  seed?: number | undefined;
}

/** The statistics engine as the server sees it; the default shells out to `agon-stats`. */
export interface StatsClient {
  analyze(input: AnalyzeInput): Promise<Result>;
  allocate(scores: SquadScoreInput[], options?: AllocateOptions): Promise<Record<string, number>>;
}

export function defaultStatsClient(): StatsClient {
  return {
    analyze: (input) => analyzeSessions(input),
    allocate: (scores, options = {}) => allocateSquads(scores, options),
  };
}
