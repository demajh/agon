import { join } from 'node:path';
import { stallGaps, type StallGapReport } from '@agon/engine';
import { SessionSchema, isAgonError } from '@agon/spec';
import type { Output } from '../output.js';
import { readJsonl, resolveRunDir } from './trace.js';

export interface StallReportOptions {
  /** A run directory (`…/agon-out/<runId>`) or an output directory holding several runs. */
  dir: string;
}

function printReport(out: Output, runDir: string, report: StallGapReport): void {
  out.heading(
    `${runDir}: ${report.sessions} sessions, ${report.sessionsWithProgress} with progress, ${report.gaps} gaps between progress events`,
  );
  out.table(
    ['p50', 'p90', 'p95', 'p99', 'max', '> 10', '> 60'],
    [[report.p50, report.p90, report.p95, report.p99, report.max, report.over10, report.over60]],
  );
  out.text(
    `  tails (steps after the last progress event, censored): ${report.tails.count} sessions, max ${report.tails.max}`,
  );
  out.text(
    out.dim(
      '  a stallSteps of N ends a session after N consecutive steps without progress, so it cuts every gap above N; pollers that correctly find nothing new should leave it unset',
    ),
  );
}

/**
 * Prints the distribution of gaps between progress events across a run's recorded sessions.
 * Fails with a non-zero exit when fewer than two sessions parse, so a format mismatch never
 * prints an empty report.
 */
export function stallReportCommand(out: Output, options: StallReportOptions): number {
  try {
    const runDir = resolveRunDir(options.dir);
    const sessions = readJsonl(join(runDir, 'sessions.jsonl'), SessionSchema);
    const report = stallGaps(sessions);
    if (out.options.json) {
      out.json({ runDir, ...report });
      return 0;
    }
    printReport(out, runDir, report);
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
