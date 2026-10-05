import { dirname, join, resolve } from 'node:path';
import { createWebAdapter } from '@agon/adapters';
import { runExperiment } from '@agon/engine';
import { createExporters } from '@agon/exporters';
import { LLM_MODES, createLlmClient, type LlmMode, type LlmUsageTotals } from '@agon/llm';
import {
  ConfigError,
  ID_PREFIXES,
  isAgonError,
  newId,
  readAgonConfig,
  type Adapter,
  type ExportConfig,
  type LlmClient,
  type Session,
} from '@agon/spec';
import pino from 'pino';
import { formatUsd, type Output } from '../output.js';
import { CliRecorder } from '../recorder.js';

export interface RunCommandOptions {
  file: string;
  variants?: string[] | undefined;
  seed?: number | undefined;
  size?: number | undefined;
  model?: string | undefined;
  concurrency?: number | undefined;
  /** Output directory; `<out>/<runId>/` receives the JSONL record and screenshots. */
  out?: string | undefined;
  llmMode?: string | undefined;
  llmCacheDir?: string | undefined;
  headful?: boolean | undefined;
  dryRun?: boolean | undefined;
  logLevel?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

type RunLlm = LlmClient & { totals?(): LlmUsageTotals };
type RunAdapter = Adapter & { dispose?(): Promise<void> };

/** Injection points so tests can run the whole command offline. */
export interface RunCommandDeps {
  llm?: RunLlm | undefined;
  adapter?: RunAdapter | undefined;
}

export interface VariantSummary {
  variant: string;
  sessions: number;
  successes: number;
  successRate: number;
  avgSteps: number;
  costUsd: number;
  outcomes: Record<string, number>;
}

export function summarizeSessions(sessions: readonly Session[]): VariantSummary[] {
  const byVariant = new Map<string, Session[]>();
  for (const s of sessions) byVariant.set(s.variant, [...(byVariant.get(s.variant) ?? []), s]);
  return [...byVariant.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([variant, list]) => {
      const successes = list.filter((s) => s.outcome === 'success').length;
      const outcomes: Record<string, number> = {};
      for (const s of list)
        outcomes[s.outcome ?? 'unknown'] = (outcomes[s.outcome ?? 'unknown'] ?? 0) + 1;
      return {
        variant,
        sessions: list.length,
        successes,
        successRate: list.length ? successes / list.length : 0,
        avgSteps: list.length ? list.reduce((a, s) => a + s.steps, 0) / list.length : 0,
        costUsd: list.reduce((a, s) => a + s.costUsd, 0),
        outcomes,
      };
    });
}

function hasJsonlSinkAt(exports: readonly ExportConfig[], outDir: string): boolean {
  return exports.some((e) => e.type === 'jsonl' && resolve(e.path) === outDir);
}

function sessionLine(out: Output, s: Session): string {
  const mark = s.outcome === 'success' ? '✓' : s.status === 'failed' ? '✗' : '·';
  return `  ${mark} ${s.id} ${s.variant} ${s.persona.personaId} → ${s.outcome ?? 'unknown'} ${out.dim(`(${s.steps} steps, ${formatUsd(s.costUsd)}${s.outcomeReason ? `; ${s.outcomeReason}` : ''})`)}`;
}

/** Simulates the population against every variant and records the run under the output directory. */
export async function runCommand(
  out: Output,
  options: RunCommandOptions,
  deps: RunCommandDeps = {},
): Promise<number> {
  const file = resolve(options.file);
  const outDir = resolve(options.out ?? process.env['AGON_OUT_DIR'] ?? './agon-out');
  const logger = pino(
    { level: options.logLevel ?? process.env['AGON_LOG_LEVEL'] ?? 'warn' },
    pino.destination(2),
  );
  const startedAt = Date.now();
  let adapter: RunAdapter | undefined;
  try {
    const config = readAgonConfig(file, { env: options.env ?? process.env });
    if (config.target.kind !== 'web') {
      throw new ConfigError(
        `target kind "${config.target.kind}" is not supported yet; only "web" targets run in this release`,
      );
    }
    if (
      options.llmMode !== undefined &&
      !(LLM_MODES as readonly string[]).includes(options.llmMode)
    ) {
      throw new ConfigError(`--llm-mode must be one of ${LLM_MODES.join(', ')}`);
    }
    const runId = newId(ID_PREFIXES.run);
    const runDir = join(outDir, runId);
    const exportConfigs: ExportConfig[] = hasJsonlSinkAt(config.export, outDir)
      ? [...config.export]
      : [{ type: 'jsonl', path: outDir }, ...config.export];

    const llm: RunLlm =
      deps.llm ??
      createLlmClient({
        ...(options.llmMode === undefined ? {} : { mode: options.llmMode as LlmMode }),
        ...(options.llmCacheDir === undefined ? {} : { cacheDir: options.llmCacheDir }),
        logger,
      });
    adapter = deps.adapter ?? createWebAdapter({ headless: !options.headful });
    const exporter = createExporters(exportConfigs, { runId, experimentName: config.name, logger });
    const recorder = new CliRecorder(exporter, {
      screenshotDir: join(runDir, 'screenshots'),
      onSessionFinished: (s) => {
        if (!out.options.json) out.text(sessionLine(out, s));
      },
    });

    if (!out.options.json) {
      out.text(
        `${out.dim(runId)} ${config.name}: ${options.dryRun ? 'planning' : 'running'} ${options.size ?? config.population.size} sessions …`,
      );
    }
    const outcome = await runExperiment(
      config,
      {
        runId,
        variants: options.variants,
        seed: options.seed,
        size: options.size,
        model: options.model,
        dryRun: options.dryRun,
        concurrency: options.concurrency,
      },
      { llm, adapters: { web: adapter }, recorder, logger, cwd: dirname(file) },
    );
    const totals = llm.totals?.();
    const summary = summarizeSessions(outcome.sessions);
    const elapsedS = (Date.now() - startedAt) / 1000;
    const exportErrors = recorder.exportErrors.map((e) => e.message);

    if (out.options.json) {
      out.json({
        runId,
        runDir,
        status: outcome.run.status,
        planned: outcome.plans.length,
        counts: outcome.run.counts,
        costUsd: outcome.run.costUsd,
        elapsedS,
        variants: summary,
        llm: totals ?? null,
        exportErrors,
      });
    } else {
      out.text();
      out.heading(
        `${runId} ${outcome.run.status}: ${outcome.sessions.length}/${outcome.plans.length} sessions, ${formatUsd(outcome.run.costUsd)}, ${elapsedS.toFixed(1)}s`,
      );
      if (options.dryRun) {
        const counts = outcome.plans.reduce<Record<string, number>>(
          (acc, p) => ({ ...acc, [p.variant]: (acc[p.variant] ?? 0) + 1 }),
          {},
        );
        out.text(
          `  planned: ${Object.entries(counts)
            .map(([v, n]) => `${v} ${n}`)
            .join(', ')} (dry run, nothing executed)`,
        );
      } else {
        out.table(
          ['variant', 'sessions', 'success', 'avg steps', 'cost', 'outcomes'],
          summary.map((v) => [
            v.variant,
            v.sessions,
            `${Math.round(v.successRate * 100)}%`,
            v.avgSteps.toFixed(1),
            formatUsd(v.costUsd),
            Object.entries(v.outcomes)
              .map(([k, n]) => `${k} ${n}`)
              .join(', '),
          ]),
        );
      }
      if (totals) {
        out.text(
          `  LLM: ${totals.calls} calls (${totals.cacheHits} cached), ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out tokens, ${formatUsd(totals.costUsd)}`,
        );
      }
      for (const message of exportErrors) out.warn(`export: ${message}`);
      out.text(`  output: ${runDir}`);
      out.text(out.dim(`  next: agon compare ${runDir}   ·   agon trace ${runDir}`));
    }
    return outcome.run.status === 'completed' ? 0 : 1;
  } catch (error) {
    const message = isAgonError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    if (out.options.json) out.json({ ok: false, error: message });
    else out.fail(message);
    return 1;
  } finally {
    await adapter?.dispose?.();
  }
}
