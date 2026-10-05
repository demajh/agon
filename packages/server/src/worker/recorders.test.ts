import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRecorder } from '@agon/engine/fakes';
import type { Step } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  composeRecorders,
  createScreenshotRecorder,
  runIdOf,
  screenshotPath,
} from './recorders.js';
import { resolveExportPaths } from './run-worker.js';

const step: Step = {
  id: 'stp_abc_00042_003',
  sessionId: 'ses_abc_00042',
  index: 3,
  observation: {
    url: 'http://x.test/',
    title: '',
    text: '',
    interactive: [],
    errors: [],
    truncated: false,
    hash: 'h',
    capturedAt: '2026-10-04T17:00:00.000Z',
  },
  decision: {
    perception: 'p',
    thinking: 't',
    feeling: 'neutral',
    progress: 'none',
    action: { type: 'back' },
  },
  result: { ok: true, navigated: false },
  patience: 0.5,
  usage: {
    model: 'fake/model-1',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    latencyMs: 1,
    cached: false,
  },
  startedAt: '2026-10-04T17:00:00.000Z',
  durationMs: 1,
};

describe('composeRecorders', () => {
  it('fans every call out to each recorder in order', async () => {
    const a = new MemoryRecorder();
    const b = new MemoryRecorder();
    const recorder = composeRecorders(a, b);
    await recorder.step(step, new Uint8Array([1]));
    await recorder.events([]);
    expect(a.calls).toEqual(['step', 'events']);
    expect(b.calls).toEqual(['step', 'events']);
    expect(a.steps[0]?.screenshot).toEqual(new Uint8Array([1]));
  });
});

describe('screenshot recorder', () => {
  it('writes <dir>/<runId>/<stepId>.png and ignores steps without screenshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agon-shots-'));
    const recorder = createScreenshotRecorder(dir);
    await recorder.step(step, undefined);
    expect(existsSync(join(dir, 'run_abc'))).toBe(false);
    await recorder.step(step, new Uint8Array([0x89, 0x50]));
    const path = screenshotPath(dir, 'run_abc', step.id);
    expect(path).toBe(join(dir, 'run_abc', `${step.id}.png`));
    expect([...readFileSync(path)]).toEqual([0x89, 0x50]);
  });

  it('derives the run id from the session id and refuses unsafe ids', () => {
    expect(runIdOf('ses_abc_00042')).toBe('run_abc');
    expect(runIdOf('weird')).toBe('weird');
    expect(() => screenshotPath('/tmp', '../etc', 'x')).toThrow(RangeError);
    expect(() => screenshotPath('/tmp', 'run_1', 'a/b')).toThrow(RangeError);
  });
});

describe('resolveExportPaths', () => {
  it('anchors relative file sinks under the exports directory and leaves the rest alone', () => {
    const out = resolveExportPaths(
      [
        { type: 'jsonl', path: './agon-out' },
        { type: 'parquet', path: '/abs/out' },
        { type: 'posthog', projectApiKey: 'k', host: 'https://us.i.posthog.com' },
      ],
      '/data/exports',
    );
    expect(out[0]).toEqual({ type: 'jsonl', path: '/data/exports/agon-out' });
    expect(out[1]).toEqual({ type: 'parquet', path: '/abs/out' });
    expect(out[2]).toEqual({
      type: 'posthog',
      projectApiKey: 'k',
      host: 'https://us.i.posthog.com',
    });
  });
});
