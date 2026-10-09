import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createMcpAdapter, createWebAdapter } from '@agon/adapters';
import { FileLedger, runExperiment } from '@agon/engine';
import { createExporters } from '@agon/exporters';
import { LLM_MODES, createLlmClient, type LlmMode, type LlmUsageTotals } from '@agon/llm';
import {
  ConfigError,
  ID_PREFIXES,
  TERMINATION_EXIT_CODES,
  isAgonError,
  newId,
  readAgonConfig,
  terminationExitCode,
  type Adapter,
  type AgonConfig,
  type ExportConfig,
  type LlmClient,
  type Run,
  type RunTermination,
  type Session,
} from '@agon/spec';
import pino from 'pino';
import { formatUsd, type Output } from '../output.js';
import { CliRecorder } from '../recorder.js';
import { ledgerDirFor } from './ledger.js';

export interface RunCommandOptions {
  file: string;
  variants?: string[] | undefined;
  seed?: number | undefined;
  size?: number | undefined;
  model?: string | undefined;
  concurrency?: number | undefined;
  /** Wall-clock cap for the whole run in ms; default `defaults.timeCapMs`. */
  timeCapMs?: number | undefined;
  /** Output directory; `<out>/<runId>/` receives the JSONL record and screenshots. */
  out?: string | undefined;
  /** Evaluation ledger directory; default `<parent of out>/.agon/ledger`. */
  ledgerDir?: string | undefined;
  llmMode?: string | undefined;
  llmCacheDir?: string | undefined;
  headful?: boolean | undefined;
  dryRun?: boolean | undefined;
  logLevel?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

type RunLlm = LlmClient & { totals?(): LlmUsageTotals };
type RunAdapter = Adapter & { dispose?(): Promise<void> };

/** The adapter for a target kind. Chromium launches lazily, so creating the web adapter is cheap. */
export function createAdapterFor(
  kind: AgonConfig['target']['kind'],
  options: { headless: boolean },
): RunAdapter {
  switch (kind) {
    case 'web':
      return createWebAdapter({ headless: options.headless });
    case 'mcp':
      return createMcpAdapter();
    default:
      throw new ConfigError(
        `target kind "${kind}" is not supported yet; web and mcp targets run in this release`,
      );
  }
}

/** Injection points so tests can run the whole command offline. */
export interface RunCommandDeps {
  llm?: RunLlm | undefined;
  adapter?: RunAdapter | undefined;
  /** The clock the time cap counts from; tests start a run in the past to hit the cap at once. */
  now?: (() => number) | undefined;
}

function describeExport(e: ExportConfig): string {
  switch (e.type) {
    case 'jsonl':
    case 'parquet':
      return `${e.type}:${resolve(e.path)}`;
    case 'posthog':
      return `posthog:${e.host}`;
    case 'amplitude':
      return `amplitude:${e.serverUrl}`;
  }
}

/**
 * The run's termination once the local sinks closed: the export stage completed when every sink
 * closed cleanly, and a partial result lists the sinks that received it.
 */
export function finalizeTermination(
  termination: RunTermination,
  exports: readonly ExportConfig[],
  exportErrors: readonly string[],
): RunTermination {
  if (exportErrors.length > 0 || termination.lastCompletedStage === 'setup') return termination;
  const written = exports.map(describeExport);
  return {
    ...termination,
    lastCompletedStage: 'export',
    ...(termination.partialDeltaManifest === undefined
      ? {}
      : {
          partialDeltaManifest: {
            ...termination.partialDeltaManifest,
            exportsWritten: written,
          },
        }),
  };
}

/** Exit code for a run that threw before it could finish: infrastructure errors get their own. */
export function exitCodeForError(error: unknown): number {
  return isAgonError(error) && (error.code === 'adapter_error' || error.code === 'llm_error')
    ? TERMINATION_EXIT_CODES.infra_aborted
    : TERMINATION_EXIT_CODES.failed;
}

function describeTermination(t: RunTermination): string {
  const head = `${t.kind} after ${(t.elapsedMs / 1000).toFixed(1)}s (cap ${t.capMs} ms) · ${t.sessionsExecuted}/${t.sessionsPlanned} sessions executed · last stage ${t.lastCompletedStage} · exit code ${terminationExitCode(t.kind)}`;
  const failure = t.firstFailure
    ? ` · first failure ${t.firstFailure.id} at ${t.firstFailure.location}: ${t.firstFailure.message}`
    : '';
  return head + failure;
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
  const startedAt = (deps.now ?? Date.now)();
  let adapter: RunAdapter | undefined;
  try {
    const config = readAgonConfig(file, { env: options.env ?? process.env });
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
    adapter = deps.adapter ?? createAdapterFor(config.target.kind, { headless: !options.headful });
    const exporter = createExporters(exportConfigs, { runId, experimentName: config.name, logger });
    const recorder = new CliRecorder(exporter, {
      screenshotDir: join(runDir, 'screenshots'),
      onSessionFinished: (s) => {
        if (!out.options.json) out.text(sessionLine(out, s));
      },
    });
    const ledger = new FileLedger(
      options.ledgerDir === undefined ? ledgerDirFor(outDir) : resolve(options.ledgerDir),
    );

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
        timeCapMs: options.timeCapMs,
        startedAt: new Date(startedAt).toISOString(),
      },
      {
        llm,
        adapters: { [adapter.kind]: adapter },
        recorder,
        ledger,
        logger,
        cwd: dirname(file),
      },
    );
    const totals = llm.totals?.();
    const summary = summarizeSessions(outcome.sessions);
    const elapsedS = (Date.now() - startedAt) / 1000;
    const exportErrors = recorder.exportErrors.map((e) => e.message);
    const termination = finalizeTermination(outcome.termination, exportConfigs, exportErrors);
    const run: Run = { ...outcome.run, termination };
    // The JSONL sink wrote run.json before the sinks closed; stamp the final stage into it.
    if (existsSync(join(runDir, 'run.json')))
      writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    const exitCode = terminationExitCode(termination.kind);

    if (out.options.json) {
      out.json({
        runId,
        runDir,
        status: run.status,
        planned: outcome.plans.length,
        counts: run.counts,
        costUsd: run.costUsd,
        elapsedS,
        termination,
        exitCode,
        sampleHash: outcome.sampleHash,
        trials: outcome.trials,
        ledgerDir: ledger.dir,
        variants: summary,
        llm: totals ?? null,
        exportErrors,
      });
    } else {
      out.text();
      out.heading(
        `${runId} ${run.status}: ${outcome.sessions.length}/${outcome.plans.length} sessions, ${formatUsd(run.costUsd)}, ${elapsedS.toFixed(1)}s`,
      );
      out.text(`  termination: ${describeTermination(termination)}`);
      out.text(
        `  sample: ${outcome.sampleHash.slice(0, 12)} · trials M=${outcome.trials} distinct treatment variant(s) evaluated against it so far (ledger ${ledger.dir})`,
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
    return exitCode;
  } catch (error) {
    const message = isAgonError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    const exitCode = exitCodeForError(error);
    if (out.options.json) out.json({ ok: false, error: message, exitCode });
    else out.fail(message);
    return exitCode;
  } finally {
    await adapter?.dispose?.();
  }
}
