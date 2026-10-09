import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATS_BIN_ENV } from '@agon/stats-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProgram } from '../program.js';
import { LIVE_WINDOW_EXIT_CODES } from './live-window.js';

const label = (latency: string, retry: string) => ({
  latencyMs: latency,
  retryRate: retry,
  abandonmentRate: '..p90',
  queueDepth: '..p90',
});
const key = (l: Record<string, string>) =>
  Object.entries(l)
    .map(([k, v]) => `${k}=${v}`)
    .join('|');

/** A report shaped like the one agon-stats writes for an injected retry storm. */
const fired = {
  kind: 'measurement',
  schemaVersion: '2026-10-09.1',
  capacity: '4 replicas',
  grainMs: 10_000,
  baseline: { samples: 600 },
  live: { samples: 320 },
  parameters: {
    percentile: 95,
    decomposeAbove: 0.25,
    minTransitions: 20,
    bootstrapSamples: 1000,
    seed: 0,
    buckets: 'baseline-quantiles',
  },
  states: 30,
  decomposed: [],
  gate: {
    status: 'fired',
    statesTested: 4,
    liveLevel: 98.75,
    signals: [
      {
        from: key(label('p90..', '..p90')),
        to: key(label('p90..', 'p90..')),
        fromLabel: label('p90..', '..p90'),
        toLabel: label('p90..', 'p90..'),
        liveProbability: 0.7,
        liveLowerBound: 0.55,
        runnerUpProbability: 0.2,
        marginLowerBound: 0.3,
        liveTransitions: 56,
        baselineProbability: 0.01,
        baselinePercentileValue: 0.05,
        baselineTransitions: 46,
        baselineSuccessor: key(label('..p90', '..p90')),
      },
    ],
  },
  computedAt: '2026-10-09T12:00:00.000Z',
  engine: { name: 'agon-stats', version: '0.0.1' },
};

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let code = -1;
  let out = '';
  const program = createProgram({ write: (t) => (out += t), exit: (c) => (code = c) });
  await program.parseAsync(['node', 'agon', ...args]);
  return { code, out };
}

describe('agon live-window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agon-live-window-cli-'));
  const previous = process.env[STATS_BIN_ENV];

  beforeAll(() => {
    // A stand-in for agon-stats: answers with a report chosen by the live file's name and records
    // the arguments it was given, so the test needs no Python.
    const reports = {
      storm: fired,
      calm: { ...fired, gate: { status: 'passed', statesTested: 9, liveLevel: 99.4, signals: [] } },
      short: {
        ...fired,
        gate: { status: 'insufficient', statesTested: 0, liveLevel: null, signals: [] },
      },
    };
    writeFileSync(join(dir, 'reports.json'), JSON.stringify(reports));
    writeFileSync(
      join(dir, 'fake-stats.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));
const live = args[args.indexOf('--live') + 1];
const reports = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'reports.json'))}, 'utf8'));
const name = Object.keys(reports).find((k) => live.includes(k));
process.stdout.write(JSON.stringify(reports[name]));
`,
    );
    process.env[STATS_BIN_ENV] = `node ${join(dir, 'fake-stats.mjs')}`;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env[STATS_BIN_ENV];
    else process.env[STATS_BIN_ENV] = previous;
  });

  it('prints the directed signals of a fired gate and exits 2', async () => {
    const { code, out } = await run([
      '--no-color',
      'live-window',
      '--baseline',
      join(dir, 'baseline.json'),
      '--live',
      join(dir, 'storm.json'),
      '--percentile',
      '99',
      '--seed',
      '4',
    ]);
    expect(code).toBe(LIVE_WINDOW_EXIT_CODES.fired);
    expect(code).toBe(2);
    expect(out).toContain('fired: 1 transition(s) changed direction');
    expect(out).toContain('latencyMs p90.., retryRate p90..');
    expect(out).toContain('latencyMs p90..');
    const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
    expect(args.slice(0, 1)).toEqual(['live-window']);
    expect(args).toEqual(expect.arrayContaining(['--percentile', '99', '--seed', '4']));
  });

  it('exits 0 when the gate passed and 3 when the window was too short to judge', async () => {
    const base = ['--no-color', 'live-window', '--baseline', join(dir, 'baseline.json'), '--live'];
    const calm = await run([...base, join(dir, 'calm.json')]);
    expect(calm.code).toBe(0);
    expect(calm.out).toContain('passed');
    const short = await run([...base, join(dir, 'short.json')]);
    expect(short.code).toBe(3);
    expect(short.out).toContain('record a longer window');
    const json = await run([
      '--json',
      'live-window',
      '--baseline',
      'b.json',
      '--live',
      join(dir, 'calm.json'),
    ]);
    expect(JSON.parse(json.out)).toMatchObject({ kind: 'measurement', gate: { status: 'passed' } });
  });

  it('refuses declared buckets whose fine edges do not refine the coarse ones', async () => {
    const buckets = join(dir, 'buckets.json');
    const coarse = {
      latencyMs: [250],
      retryRate: [0.05],
      abandonmentRate: [0.1],
      queueDepth: [10],
    };
    writeFileSync(buckets, JSON.stringify({ coarse, fine: { ...coarse, latencyMs: [100] } }));
    const { code, out } = await run([
      '--no-color',
      'live-window',
      '--baseline',
      'b.json',
      '--live',
      join(dir, 'calm.json'),
      '--buckets',
      buckets,
    ]);
    expect(code).toBe(1);
    expect(out).toContain('must contain every coarse edge');
  });
});
