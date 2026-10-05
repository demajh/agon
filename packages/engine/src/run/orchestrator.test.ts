import { RunSchema } from '@agon/spec';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../fakes/config.js';
import { FakeAdapter, FakeLlm, MemoryRecorder, happyUser, ledgerlySite } from '../fakes/fakes.js';
import { runExperiment } from './orchestrator.js';

const logger = pino({ level: 'silent' });

describe('runExperiment', () => {
  it('runs every planned session across variants with bounded concurrency and records the run', async () => {
    const config = testConfig({
      population: { seed: 3, size: 6, personas: [{ use: 'eager' }], traitJitter: 0 },
    });
    const adapter = new FakeAdapter(ledgerlySite);
    const recorder = new MemoryRecorder();
    const outcome = await runExperiment(
      config,
      { runId: 'run_orch', concurrency: 2 },
      { llm: new FakeLlm(happyUser), adapters: { web: adapter }, recorder, logger },
    );
    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.counts).toEqual({ planned: 6, running: 0, completed: 6, failed: 0 });
    expect(outcome.sessions).toHaveLength(6);
    expect(outcome.sessions.filter((s) => s.variant === 'control')).toHaveLength(3);
    expect(outcome.sessions.filter((s) => s.variant === 'treatment')).toHaveLength(3);
    expect(outcome.sessions.every((s) => s.outcome === 'success')).toBe(true);
    expect(outcome.run.costUsd).toBeCloseTo(6 * 6 * 0.001);
    expect(
      adapter.sessions.map((s) => s.options.variant).filter((v) => v === 'treatment'),
    ).toHaveLength(3);
    expect(RunSchema.safeParse(outcome.run).success).toBe(true);
    expect(recorder.calls[0]).toBe('runStarted');
    expect(recorder.calls.at(-1)).toBe('runFinished');
    expect(recorder.finishedRuns[0]?.run.finishedAt).toBeDefined();
  });

  it('honours variant subsets, dry runs, and reports failures without aborting the run', async () => {
    const config = testConfig({ population: { seed: 3, size: 4, personas: [{ use: 'eager' }] } });
    const dry = await runExperiment(
      config,
      { runId: 'run_dry', variants: ['treatment'], dryRun: true },
      {
        llm: new FakeLlm(happyUser),
        adapters: { web: new FakeAdapter() },
        recorder: new MemoryRecorder(),
        logger,
      },
    );
    expect(dry.plans).toHaveLength(4);
    expect(dry.plans.every((p) => p.variant === 'treatment')).toBe(true);
    expect(dry.sessions).toHaveLength(0);
    expect(dry.run.status).toBe('completed');

    const broken = await runExperiment(
      config,
      { runId: 'run_broken' },
      {
        llm: new FakeLlm(happyUser),
        adapters: { web: new FakeAdapter(ledgerlySite, { failOnOpen: true }) },
        recorder: new MemoryRecorder(),
        logger,
      },
    );
    expect(broken.run.status).toBe('failed');
    expect(broken.run.counts.failed).toBe(4);
    expect(broken.run.error).toMatch(/every session failed/);
  });

  it('rejects unknown variants and missing adapters up front', async () => {
    const config = testConfig();
    const deps = {
      llm: new FakeLlm(happyUser),
      adapters: { web: new FakeAdapter() },
      recorder: new MemoryRecorder(),
      logger,
    };
    await expect(runExperiment(config, { variants: ['nope'] }, deps)).rejects.toThrow(
      /unknown variant "nope"/,
    );
    await expect(runExperiment(config, {}, { ...deps, adapters: {} })).rejects.toThrow(
      /no adapter registered/,
    );
  });
});
