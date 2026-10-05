import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunSchema, isAgonError, type Analysis, type MetricResult, type Result } from '@agon/spec';
import { analyzeSessions, buildAnalysisConfig } from '@agon/stats-client';
import { formatUsd, type Output } from '../output.js';
import { resolveRunDir } from './trace.js';

export interface CompareOptions {
  dir: string;
  method?: Analysis['method'] | undefined;
  control?: string | undefined;
  minSessions?: number | undefined;
  profile?: string | undefined;
  category?: string | undefined;
  seed?: number | undefined;
}

function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}

function metricRows(m: MetricResult, primary: boolean): (string | number)[][] {
  return m.variants.map((v) => {
    const c = m.comparisons.find((x) => x.variant === v.variant);
    return [
      `${m.metricId}${primary ? '*' : ''}`,
      v.variant,
      v.sessions,
      v.mean.toFixed(3),
      `[${v.ci95[0].toFixed(3)}, ${v.ci95[1].toFixed(3)}]`,
      c ? pct(c.lift) : '—',
      c ? c.pBest.toFixed(3) : '—',
      c ? c.pBeatControl.toFixed(3) : '—',
      c?.pValue !== undefined ? c.pValue.toFixed(4) : '',
    ];
  });
}

/** Prints a Result. Every lift shares the table with the calibration note (invariant 7). */
export function printResult(out: Output, result: Result, runDir: string): void {
  out.heading(
    `${result.id} · ${result.method} · control = ${result.control} · ${result.sessionsAnalyzed} sessions analyzed`,
  );
  const verdict = result.decision.verdict.toUpperCase();
  out.text(
    `  verdict: ${verdict}${result.decision.variant ? ` ${result.decision.variant}` : ''} — ${result.decision.rationale}`,
  );
  out.text();
  out.table(
    ['metric', 'variant', 'n', 'mean', '95% CI', 'lift', 'P(best)', 'P(beat ctl)', 'p'],
    result.metrics.flatMap((m) => metricRows(m, m.metricId === result.primaryMetricId)),
  );
  const warnings = result.metrics.flatMap((m) => m.warnings.map((w) => `${m.metricId}: ${w}`));
  if (warnings.length) {
    out.text();
    for (const w of warnings.slice(0, 12)) out.warn(w);
    if (warnings.length > 12) out.text(out.dim(`  … ${warnings.length - 12} more warnings`));
  }
  out.text();
  const accuracy = result.calibration.directionAccuracy;
  out.text(
    `  calibration: ${result.calibration.profile}${result.calibration.changeCategory ? ` (${result.calibration.changeCategory})` : ''}${accuracy === undefined ? '' : `, direction accuracy ${(accuracy * 100).toFixed(0)}%`} — ${result.calibration.note}`,
  );
  out.text(out.dim(`  result: ${join(runDir, 'result.json')}`));
}

/** Analyzes a recorded run with agon-stats and writes result.json next to it. */
export async function compareCommand(out: Output, options: CompareOptions): Promise<number> {
  try {
    const runDir = resolveRunDir(options.dir);
    const run = RunSchema.parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
    const sessionsPath = join(runDir, 'sessions.jsonl');
    if (!existsSync(sessionsPath))
      throw new Error(`${sessionsPath} is missing; did the run record any sessions?`);
    const analysis = buildAnalysisConfig(
      run.config,
      { id: run.id, seed: run.seed },
      {
        method: options.method,
        control: options.control,
        minSessionsPerVariant: options.minSessions,
        calibrationProfile: options.profile,
        changeCategory: options.category,
        seed: options.seed,
      },
    );
    const result = await analyzeSessions({
      sessionsPath,
      analysis,
      outPath: join(runDir, 'result.json'),
    });
    if (out.options.json) {
      out.json({ runDir, result });
      return 0;
    }
    printResult(out, result, runDir);
    out.text(out.dim(`  run cost: ${formatUsd(run.costUsd)}`));
    return 0;
  } catch (error) {
    const message = isAgonError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    if (out.options.json) out.json({ ok: false, error: message });
    else out.fail(message);
    return 1;
  }
}
