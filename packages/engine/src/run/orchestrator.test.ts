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
    expect(outcome.run.counts).toEqual({
      planned: 6,
      running: 0,
      completed: 6,
      failed: 0,
      interrupted: 0,
    });
    expect(outcome.termination).toMatchObject({
      kind: 'completed',
      capMs: 720_000,
      lastCompletedStage: 'sessions',
      sessionsExecuted: 6,
      sessionsPlanned: 6,
      failureCount: 0,
    });
    expect(outcome.termination.partialDeltaManifest).toBeUndefined();
    expect(outcome.termination.firstFailure).toBeUndefined();
    expect(outcome.run.termination).toEqual(outcome.termination);
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
    expect(dry.termination).toMatchObject({
      kind: 'completed',
      lastCompletedStage: 'setup',
      sessionsExecuted: 0,
      sessionsPlanned: 4,
    });

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
    // The adapter could not open the target: not the product's fault.
    expect(broken.termination).toMatchObject({
      kind: 'infra_aborted',
      sessionsExecuted: 4,
      failureCount: 4,
      firstFailure: {
        id: 'ses_broken_00000',
        location: 'adapter open',
        message: 'browser failed to launch',
      },
    });
  });

  it('stops promptly when the signal fires and marks the run cancelled', async () => {
    const config = testConfig({ population: { seed: 3, size: 6, personas: [{ use: 'eager' }] } });
    const controller = new AbortController();
    let calls = 0;
    const slowUser: typeof happyUser = (p, r) => {
      if (++calls === 3) controller.abort();
      return happyUser(p, r);
    };
    const outcome = await runExperiment(
      config,
      { runId: 'run_cancel', concurrency: 1 },
      {
        llm: new FakeLlm(slowUser),
        adapters: { web: new FakeAdapter() },
        recorder: new MemoryRecorder(),
        logger,
        signal: controller.signal,
      },
    );
    expect(outcome.run.status).toBe('cancelled');
    expect(outcome.sessions.length).toBeLessThan(6);
    const cancelled = outcome.sessions.find((s) => s.outcomeReason === 'cancelled');
    expect(cancelled?.status).toBe('failed');
    expect(cancelled?.outcome).toBe('error');
    expect(calls).toBeLessThan(10);
    expect(outcome.termination.kind).toBe('cancelled');
    expect(outcome.termination.partialDeltaManifest).toBeDefined();
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

  it('stops at the time cap, keeps the completed sessions and returns a typed partial outcome', async () => {
    const config = testConfig({
      population: { seed: 3, size: 6, personas: [{ use: 'eager' }], traitJitter: 0 },
    });
    // 20 ms per decision, six decisions per session: one session every 120 ms at concurrency 1.
    const llm = new FakeLlm(happyUser);
    const slow: typeof llm = Object.assign(llm, {
      generateObject: async <T>(request: Parameters<typeof llm.generateObject<T>>[0]) => {
        await new Promise((r) => setTimeout(r, 20));
        return FakeLlm.prototype.generateObject.call(llm, request) as ReturnType<
          typeof llm.generateObject<T>
        >;
      },
    });
    const recorder = new MemoryRecorder();
    const outcome = await runExperiment(
      config,
      { runId: 'run_cap', concurrency: 1, timeCapMs: 300 },
      { llm: slow, adapters: { web: new FakeAdapter(ledgerlySite) }, recorder, logger },
    );
    expect(outcome.run.status).toBe('completed');
    expect(outcome.termination.kind).toBe('time_cap_reached');
    expect(outcome.termination.capMs).toBe(300);
    expect(outcome.termination.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(outcome.termination.sessionsPlanned).toBe(6);
    expect(outcome.termination.sessionsExecuted).toBeGreaterThanOrEqual(1);
    expect(outcome.termination.sessionsExecuted).toBeLessThan(6);
    expect(outcome.termination.failureCount).toBe(0);
    expect(outcome.run.counts.completed).toBe(outcome.termination.sessionsExecuted);
    expect(outcome.run.counts.interrupted).toBeGreaterThanOrEqual(1);
    expect(outcome.run.counts.interrupted + outcome.run.counts.completed).toBe(
      outcome.sessions.length,
    );
    // Completed sessions are kept, with their outcomes; interrupted ones carry no outcome.
    const completed = outcome.sessions.filter((s) => s.status === 'finished');
    expect(completed.length).toBe(outcome.termination.sessionsExecuted);
    expect(completed.every((s) => s.outcome === 'success')).toBe(true);
    const interrupted = outcome.sessions.filter((s) => s.status === 'failed');
    expect(interrupted.length).toBe(outcome.run.counts.interrupted);
    for (const s of interrupted) {
      expect(s.outcome).toBeUndefined();
      expect(s.error).toBe('run time cap reached');
      expect(s.outcomeReason).toBe('run time cap reached');
    }
    const manifest = outcome.termination.partialDeltaManifest;
    expect(manifest).toBeDefined();
    expect(Object.keys(manifest?.sessionsPerVariant ?? {}).sort()).toEqual([
      'control',
      'treatment',
    ]);
    expect(Object.values(manifest?.sessionsPerVariant ?? {}).reduce((a, b) => a + b, 0)).toBe(
      completed.length,
    );
    expect(manifest?.metricsComputed).toContain('scenario_success');
    expect(recorder.sessionsFinished).toHaveLength(outcome.sessions.length);
    expect(RunSchema.safeParse(outcome.run).success).toBe(true);
    expect(outcome.run.termination?.kind).toBe('time_cap_reached');
  });

  it('counts queue time against the cap: a run whose clock expired launches nothing', async () => {
    const config = testConfig({ population: { seed: 3, size: 4, personas: [{ use: 'eager' }] } });
    const outcome = await runExperiment(
      config,
      { runId: 'run_late', startedAt: new Date(Date.now() - 720_000).toISOString() },
      {
        llm: new FakeLlm(happyUser),
        adapters: { web: new FakeAdapter(ledgerlySite) },
        recorder: new MemoryRecorder(),
        logger,
      },
    );
    expect(outcome.termination).toMatchObject({
      kind: 'time_cap_reached',
      sessionsExecuted: 0,
      sessionsPlanned: 4,
      failureCount: 0,
      partialDeltaManifest: {
        sessionsPerVariant: { control: 0, treatment: 0 },
        metricsComputed: [],
        exportsWritten: [],
      },
    });
    expect(outcome.sessions).toHaveLength(0);
    expect(outcome.run.status).toBe('completed');
    await expect(
      runExperiment(
        config,
        { startedAt: 'yesterday' },
        {
          llm: new FakeLlm(happyUser),
          adapters: { web: new FakeAdapter() },
          recorder: new MemoryRecorder(),
          logger,
        },
      ),
    ).rejects.toThrow(/invalid startedAt/);
  });
});
