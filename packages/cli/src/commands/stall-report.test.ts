import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunSchema, SessionSchema, type Session } from '@agon/spec';
import { testConfig } from '@agon/engine/fakes';
import { describe, expect, it } from 'vitest';
import { Output } from '../output.js';
import { stallReportCommand } from './stall-report.js';

function capture(json = false): { out: Output; text: () => string } {
  let text = '';
  const out = new Output({ json, color: false }, (t) => (text += t));
  return { out, text: () => text };
}

function session(index: number, steps: number, progressSteps?: number[]): Session {
  return SessionSchema.parse({
    id: `ses_t_${String(index).padStart(5, '0')}`,
    runId: 'run_t',
    index,
    variant: 'control',
    scenarioId: 'first-project',
    persona: {
      personaId: 'eager',
      name: 'Eager',
      summary: 'x',
      traits: { role: 'owner' },
      goals: [],
      frustrations: [],
      device: 'desktop',
      locale: 'en-US',
      model: 'fake/model-1',
      seed: index,
      distinctId: `sim_${index}`,
    },
    status: 'finished',
    outcome: 'success',
    steps,
    ...(progressSteps === undefined ? {} : { progressSteps }),
  });
}

function writeRun(sessions: Session[]): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'agon-stall-')), 'run_t');
  mkdirSync(dir, { recursive: true });
  const run = RunSchema.parse({
    id: 'run_t',
    environmentId: 'env_t',
    status: 'completed',
    variants: ['control'],
    seed: 1,
    config: testConfig(),
    createdAt: '2026-10-09T00:00:00.000Z',
  });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
  writeFileSync(join(dir, 'sessions.jsonl'), sessions.map((s) => JSON.stringify(s)).join('\n'));
  return dir;
}

describe('agon stall-report', () => {
  it('prints the gap distribution of a recorded run, as text and json', () => {
    const dir = writeRun([session(0, 10, [2, 5, 10]), session(1, 30, [12, 24]), session(2, 8, [])]);
    const text = capture();
    expect(stallReportCommand(text.out, { dir })).toBe(0);
    expect(text.text()).toContain('3 sessions, 2 with progress, 5 gaps');
    expect(text.text()).toMatch(/p50\s+p90\s+p95\s+p99\s+max\s+> 10\s+> 60/);
    expect(text.text()).toMatch(/5\s+12\s+12\s+12\s+12\s+2\s+0/);
    const json = capture(true);
    expect(stallReportCommand(json.out, { dir })).toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({
      runDir: dir,
      sessions: 3,
      gaps: 5,
      max: 12,
      over10: 2,
      tails: { count: 2, max: 8 },
    });
  });

  it('fails with a clear message instead of an empty report', () => {
    const one = capture();
    expect(stallReportCommand(one.out, { dir: writeRun([session(0, 5, [1])]) })).toBe(1);
    expect(one.text()).toMatch(/✗ .*at least 2 recorded sessions, got 1/);
    const old = capture(true);
    expect(stallReportCommand(old.out, { dir: writeRun([session(0, 5), session(1, 6)]) })).toBe(1);
    expect(JSON.parse(old.text())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/progress data/),
    });
    const missing = capture();
    expect(stallReportCommand(missing.out, { dir: join(tmpdir(), 'nope-agon') })).toBe(1);
  });
});
