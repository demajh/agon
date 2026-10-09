import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_SCHEMA_VERSION } from './contract.js';
import {
  LIVE_WINDOW_SERIES,
  LiveWindowBucketsSchema,
  LiveWindowReportSchema,
  LiveWindowSchema,
} from './live-window.js';

describe('live window input', () => {
  it('accepts four aligned series at one grain and rejects misaligned ones', () => {
    const window = LiveWindowSchema.parse({
      capacity: '4 replicas',
      grainMs: 10_000,
      series: {
        latencyMs: [100, 120, 130],
        retryRate: [0, 0.01, 0.02],
        abandonmentRate: [0, 0, 0.01],
        queueDepth: [2, 3, 5],
      },
    });
    expect(LIVE_WINDOW_SERIES.map((s) => window.series[s].length)).toEqual([3, 3, 3, 3]);
    expect(() =>
      LiveWindowSchema.parse({
        capacity: '4 replicas',
        grainMs: 10_000,
        series: { latencyMs: [1, 2], retryRate: [0], abandonmentRate: [0, 0], queueDepth: [0, 0] },
      }),
    ).toThrow(/aligned/);
    expect(() =>
      LiveWindowSchema.parse({
        capacity: '4 replicas',
        grainMs: 10_000,
        series: {
          latencyMs: [1, 2],
          retryRate: [0, 1.5],
          abandonmentRate: [0, 0],
          queueDepth: [0, 0],
        },
      }),
    ).toThrow();
  });

  it('accepts declared buckets only when the fine edges refine the coarse ones', () => {
    const coarse = {
      latencyMs: [250],
      retryRate: [0.05],
      abandonmentRate: [0.1],
      queueDepth: [10],
    };
    expect(LiveWindowBucketsSchema.parse({ coarse }).fine).toBeUndefined();
    const fine = { ...coarse, latencyMs: [120, 250, 800] };
    expect(LiveWindowBucketsSchema.parse({ coarse, fine }).fine?.latencyMs).toEqual([
      120, 250, 800,
    ]);
    expect(() =>
      LiveWindowBucketsSchema.parse({ coarse, fine: { ...coarse, latencyMs: [120, 800] } }),
    ).toThrow(/every coarse edge/);
    expect(() =>
      LiveWindowBucketsSchema.parse({ coarse: { ...coarse, queueDepth: [10, 5] } }),
    ).toThrow(/increase/);
  });
});

describe('live window report', () => {
  // Written by `agon-stats live-window` on a calm baseline and a window with an injected retry
  // storm (packages/stats/tests/test_transitions.py); the TypeScript schema must read it as is.
  const report = LiveWindowReportSchema.parse(
    JSON.parse(
      readFileSync(new URL('./__fixtures__/live-window-report.json', import.meta.url), 'utf8'),
    ),
  );

  it('is a measurement stamped with the contract version', () => {
    expect(report.kind).toBe('measurement');
    expect(report.schemaVersion).toBe(CONTRACT_SCHEMA_VERSION);
    expect(report.parameters).toMatchObject({ percentile: 95, minTransitions: 20 });
  });

  it('reports the loop as directed transitions, not a distance', () => {
    expect(report.gate.status).toBe('fired');
    expect(report.gate.liveLevel).toBeCloseTo(100 - 5 / report.gate.statesTested);
    const up = (label: Record<string, string>) =>
      LIVE_WINDOW_SERIES.filter((s) => label[s]?.startsWith('p9')).join('+');
    const edges = report.gate.signals.map((s) => `${up(s.fromLabel)} -> ${up(s.toLabel)}`);
    expect(edges.sort()).toEqual([
      'latencyMs -> latencyMs+retryRate',
      'latencyMs+retryRate -> latencyMs+retryRate+abandonmentRate+queueDepth',
      'latencyMs+retryRate+abandonmentRate+queueDepth -> latencyMs',
    ]);
    for (const signal of report.gate.signals) {
      expect(signal.liveLowerBound).toBeGreaterThan(signal.baselinePercentileValue);
      expect(signal.marginLowerBound).toBeGreaterThan(0);
    }
  });
});
