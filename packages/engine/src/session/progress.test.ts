import { nowIso, type AgonEvent, type Observation } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  ProgressTracker,
  countProgressEvents,
  progressHash,
  quantile,
  stallGaps,
  type StallGapInput,
} from './progress.js';

function observation(hash: string): Observation {
  return {
    url: 'http://x/',
    title: '',
    text: 'page',
    interactive: [],
    errors: [],
    truncated: false,
    hash,
    capturedAt: nowIso(),
  };
}

function event(
  name: string,
  source: AgonEvent['source'],
  properties: Record<string, unknown> = {},
): AgonEvent {
  return {
    id: `evt_${name}_${Math.floor(Object.keys(properties).length)}`,
    runId: 'run_t',
    sessionId: 'ses_t',
    timestamp: nowIso(),
    event: name,
    distinctId: 'sim_1',
    source,
    properties: {
      ...properties,
      agon_simulated: true,
      agon_run_id: 'run_t',
      agon_session_id: 'ses_t',
      agon_variant: 'control',
      agon_persona: 'eager',
      agon_model: 'fake/m',
    },
  };
}

describe('progressHash', () => {
  const events = [
    event('$agon_session_start', 'inferred'),
    event('signup_completed', 'intercepted'),
    event('$agon_tool_call', 'inferred', { is_error: false }),
    event('$agon_tool_call', 'inferred', { is_error: true }),
    event('$agon_click', 'inferred'),
  ];

  it('counts intercepted rows and successful tool calls as progress events', () => {
    expect(countProgressEvents(events)).toBe(2);
    expect(countProgressEvents([])).toBe(0);
  });

  it('follows the declared signal', () => {
    expect(progressHash('observation', observation('a'), events)).toBe('o:a');
    expect(progressHash('events', observation('a'), events)).toBe('e:2');
    expect(progressHash('both', observation('a'), events)).toBe('o:a|e:2');
    expect(progressHash('events', observation('b'), events)).toBe(
      progressHash('events', observation('a'), events),
    );
  });
});

describe('ProgressTracker', () => {
  it('counts consecutive steps without a hash change and resets on progress', () => {
    const t = new ProgressTracker();
    expect(t.observe('a', 0)).toBe(false); // seeds
    expect(t.observe('a', 1)).toBe(false);
    expect(t.observe('a', 2)).toBe(false);
    expect(t.stepsSinceProgress).toBe(2);
    expect(t.stalled(3)).toBe(false);
    expect(t.observe('b', 3)).toBe(true);
    expect(t.stepsSinceProgress).toBe(0);
    expect(t.lastProgressStep).toBe(3);
    expect(t.observe('b', 4)).toBe(false);
    expect(t.observe('b', 5)).toBe(false);
    expect(t.observe('b', 6)).toBe(false);
    expect(t.stalled(3)).toBe(true);
    expect(t.stalled(undefined)).toBe(false);
    expect(t.summary()).toEqual({
      maxStepsSinceProgress: 3,
      lastProgressStep: 3,
      progressSteps: [3],
    });
  });
});

describe('stallGaps', () => {
  const session = (steps: number, progressSteps?: number[]): StallGapInput => ({
    steps,
    ...(progressSteps === undefined ? {} : { progressSteps }),
  });

  it('reports the gap distribution over synthetic sessions', () => {
    const report = stallGaps([
      session(10, [2, 5, 10]), // gaps 2, 3, 5; no tail
      session(30, [12, 24]), // gaps 12, 12; tail 6
      session(8, []), // never progressed; tail 8
      session(70, [70]), // gap 70
    ]);
    expect(report).toEqual({
      sessions: 4,
      sessionsWithProgress: 3,
      gaps: 6,
      p50: 5,
      p90: 70,
      p95: 70,
      p99: 70,
      max: 70,
      over10: 3,
      over60: 1,
      tails: { count: 2, max: 8 },
    });
  });

  it('fails loudly on fewer than two sessions or sessions without progress data', () => {
    expect(() => stallGaps([session(5, [1])])).toThrow(/at least 2 recorded sessions/);
    expect(() => stallGaps([])).toThrow(/at least 2 recorded sessions/);
    expect(() => stallGaps([session(5), session(6)])).toThrow(/progress data/);
  });

  it('uses nearest-rank quantiles', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.5)).toBe(5);
    expect(quantile(sorted, 0.9)).toBe(9);
    expect(quantile(sorted, 0.99)).toBe(10);
    expect(quantile([], 0.5)).toBe(0);
  });
});
