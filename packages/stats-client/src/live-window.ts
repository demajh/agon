import { writeFileSync } from 'node:fs';
import {
  AgonError,
  ErrorCodes,
  LiveWindowBucketsSchema,
  LiveWindowReportSchema,
  type LiveWindowBuckets,
  type LiveWindowReport,
} from '@agon/spec';
import { z } from 'zod';
import { runStats, safeJson, type StatsRunOptions } from './analyze.js';

/** What `agon-stats live-window` reads: two `LiveWindow` files and the gate's parameters. */
export interface LiveWindowGateInput {
  /** Pre-release window (spec `LiveWindow`), recorded at the same capacity and grain. */
  baselinePath: string;
  /** The live window after the release. */
  livePath: string;
  /** Declared bucket edges; default: the baseline's 90th percentile (coarse), 50/90/99th (fine). */
  buckets?: LiveWindowBuckets | undefined;
  percentile?: number | undefined;
  decomposeAbove?: number | undefined;
  minTransitions?: number | undefined;
  bootstrapSamples?: number | undefined;
  seed?: number | undefined;
  /** Where to write the report as JSON; also returned. */
  outPath?: string | undefined;
}

/**
 * Runs the transition-matrix gate (`agon-stats live-window`) and returns the validated
 * `LiveWindowReport`, a measurement. See docs/live-window-recorder.md.
 */
export async function liveWindowGate(
  input: LiveWindowGateInput,
  options: StatsRunOptions = {},
): Promise<LiveWindowReport> {
  const args = ['live-window', '--baseline', input.baselinePath, '--live', input.livePath];
  if (input.buckets !== undefined) {
    args.push('--buckets', JSON.stringify(LiveWindowBucketsSchema.parse(input.buckets)));
  }
  const numeric: [string, number | undefined][] = [
    ['--percentile', input.percentile],
    ['--decompose-above', input.decomposeAbove],
    ['--min-transitions', input.minTransitions],
    ['--bootstrap-samples', input.bootstrapSamples],
    ['--seed', input.seed],
  ];
  for (const [flag, value] of numeric) if (value !== undefined) args.push(flag, String(value));
  const stdout = await runStats(args, options);
  const parsed = LiveWindowReportSchema.safeParse(safeJson(stdout.trim()));
  if (!parsed.success) {
    throw new AgonError(
      ErrorCodes.INTERNAL,
      `agon-stats live-window returned an invalid report:\n${z.prettifyError(parsed.error)}`,
      { details: { stdout: stdout.slice(0, 2000) } },
    );
  }
  if (input.outPath) writeFileSync(input.outPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}
