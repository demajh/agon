import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LIVE_WINDOW_SERIES,
  LiveWindowBucketsSchema,
  ValidationError,
  isAgonError,
  type GateSignal,
  type LiveWindowBuckets,
  type LiveWindowGateStatus,
  type LiveWindowReport,
} from '@agon/spec';
import { liveWindowGate } from '@agon/stats-client';
import { z } from 'zod';
import type { Output } from '../output.js';

/** `agon live-window` exit codes: CI can tell a fired gate from a window too short to judge. */
export const LIVE_WINDOW_EXIT_CODES: Readonly<Record<LiveWindowGateStatus, number>> = {
  passed: 0,
  fired: 2,
  insufficient: 3,
};

export interface LiveWindowOptions {
  baseline: string;
  live: string;
  buckets?: string | undefined;
  percentile?: number | undefined;
  decomposeAbove?: number | undefined;
  minTransitions?: number | undefined;
  bootstrapSamples?: number | undefined;
  seed?: number | undefined;
  out?: string | undefined;
}

/** `latencyMs p99.. | retryRate p90..p99` for the series outside their lowest band. */
function describeState(label: Record<string, string>): string {
  const raised = LIVE_WINDOW_SERIES.filter((s) => !(label[s] ?? '').startsWith('..'));
  return raised.length === 0 ? 'all low' : raised.map((s) => `${s} ${label[s]}`).join(', ');
}

function signalRow(s: GateSignal): (string | number)[] {
  return [
    describeState(s.fromLabel),
    describeState(s.toLabel),
    `${(s.liveProbability * 100).toFixed(0)}% (>= ${(s.liveLowerBound * 100).toFixed(0)}%)`,
    `${(s.baselinePercentileValue * 100).toFixed(0)}%`,
    `${s.liveTransitions}/${s.baselineTransitions}`,
  ];
}

function printReport(out: Output, report: LiveWindowReport): void {
  const { gate, parameters } = report;
  out.heading(
    `live window at ${report.capacity}, ${report.grainMs} ms grain: ${report.live.samples} live samples against ${report.baseline.samples} baseline samples (measurement)`,
  );
  out.text(
    `  ${report.states} states, ${report.decomposed.length} cluster(s) decomposed, ${gate.statesTested} state(s) with at least ${parameters.minTransitions} live transitions tested`,
  );
  if (gate.status === 'insufficient') {
    out.warn('no state had enough live transitions to judge: record a longer window');
    return;
  }
  if (gate.status === 'passed') {
    out.ok(
      `passed: no transition improbable before the release (above the baseline's ${parameters.percentile}th percentile) became the most likely successor of its state`,
    );
    return;
  }
  out.fail(`fired: ${gate.signals.length} transition(s) changed direction`);
  out.table(
    ['from', 'to', 'live share', `baseline p${parameters.percentile}`, 'transitions live/base'],
    gate.signals.map(signalRow),
  );
}

/** Runs the transition-matrix gate through agon-stats. Exit 0 passed, 2 fired, 3 insufficient, 1 error. */
export async function liveWindowCommand(out: Output, options: LiveWindowOptions): Promise<number> {
  let report: LiveWindowReport;
  try {
    let buckets: LiveWindowBuckets | undefined;
    if (options.buckets !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(resolve(options.buckets), 'utf8'));
      } catch (error) {
        throw new ValidationError(
          `cannot read buckets ${options.buckets}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const parsed = LiveWindowBucketsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError(
          `invalid buckets ${options.buckets}:\n${z.prettifyError(parsed.error)}`,
        );
      }
      buckets = parsed.data;
    }
    report = await liveWindowGate({
      baselinePath: resolve(options.baseline),
      livePath: resolve(options.live),
      buckets,
      percentile: options.percentile,
      decomposeAbove: options.decomposeAbove,
      minTransitions: options.minTransitions,
      bootstrapSamples: options.bootstrapSamples,
      seed: options.seed,
      outPath: options.out === undefined ? undefined : resolve(options.out),
    });
  } catch (error) {
    const text = isAgonError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    if (out.options.json) out.json({ ok: false, error: text });
    else out.fail(text);
    return 1;
  }
  if (out.options.json) out.json(report);
  else printReport(out, report);
  return LIVE_WINDOW_EXIT_CODES[report.gate.status];
}
