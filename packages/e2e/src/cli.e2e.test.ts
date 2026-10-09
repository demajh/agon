import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebAdapter } from '@agon/adapters';
import { Output, compareCommand, runCommand, traceCommand } from '@agon/cli';
import { FakeLlm } from '@agon/engine/fakes';
import { JSONL_FILES } from '@agon/exporters';
import {
  AgonEventSchema,
  ResultSchema,
  RunSchema,
  SessionSchema,
  StepSchema,
  requirementsDigest,
} from '@agon/spec';
import type { AgonEvent, Result, Session, Step } from '@agon/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAnalyticsSink, startDemoApp } from './demo.js';
import type { AnalyticsSink, RunningServer } from './demo.js';
import { ledgerlyUser } from './ledgerly-user.js';

/** The same experiment as examples/demo-app/agon.yaml, pointed at the in-process servers. */
const CONFIG = `
version: 1
name: ledgerly-e2e-cli
description: Does the two-step onboarding activate more new users than the five-step flow?
target:
  kind: web
  variants:
    control:
      url: \${E2E_CONTROL_URL}
      description: Five onboarding steps after signup.
    treatment:
      url: \${E2E_TREATMENT_URL}
      description: One prefilled "Create project" step after signup.
  capture:
    analytics: [posthog]
    screenshots: every_step
population:
  seed: 5
  size: 8
  personas:
    - { use: builtin/ops-manager, weight: 1 }
    - { use: builtin/power-user, weight: 1 }
scenarios:
  - id: first-project
    goal: You just heard about Ledgerly. Sign up and create your first project.
    success: event:project_created
    maxSteps: 25
metrics:
  - { id: activation, type: conversion, event: project_created, primary: true }
  - { id: time_to_activate, type: duration, from: session_start, to: project_created }
  - { id: steps, type: steps }
analysis:
  minSessionsPerVariant: 1
defaults:
  model: fake/model
  maxConcurrency: 2
`;

const SIZE = 2;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let sink: AnalyticsSink;
let control: RunningServer;
let treatment: RunningServer;
let file: string;
let outDir: string;
let runDir: string;
let sessions: Session[];

function capture(json = false): { out: Output; text: () => string } {
  let text = '';
  const out = new Output({ json, color: false }, (chunk) => (text += chunk));
  return { out, text: () => text };
}

function readJsonl<T>(path: string, schema: { parse(input: unknown): T }): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => schema.parse(JSON.parse(line)));
}

const variantUrl = (variant: string): string => (variant === 'control' ? control : treatment).url;

beforeAll(async () => {
  sink = await startAnalyticsSink();
  [control, treatment] = await Promise.all([
    startDemoApp('control', { posthogHost: sink.url }),
    startDemoApp('treatment', { posthogHost: sink.url }),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'agon-e2e-cli-'));
  file = join(dir, 'agon.yaml');
  writeFileSync(file, CONFIG);
  outDir = join(dir, 'agon-out');
});

afterAll(async () => {
  await Promise.all([control?.close(), treatment?.close(), sink?.close()]);
});

describe('agon run → trace → compare on the live demo app', () => {
  it('agon run drives both variants through the browser and records the run on disk', async () => {
    const { out, text } = capture();
    const code = await runCommand(
      out,
      {
        file,
        out: outDir,
        llmMode: 'off',
        size: SIZE,
        env: { E2E_CONTROL_URL: control.url, E2E_TREATMENT_URL: treatment.url },
      },
      // runCommand disposes the adapter it is handed, so no cleanup is needed here.
      { llm: new FakeLlm(ledgerlyUser), adapter: createWebAdapter() },
    );
    expect(code, text()).toBe(0);

    const runDirs = readdirSync(outDir).filter((d) => d.startsWith('run_'));
    expect(runDirs).toHaveLength(1);
    runDir = join(outDir, runDirs[0] as string);
    for (const name of [
      JSONL_FILES.run,
      JSONL_FILES.sessions,
      JSONL_FILES.steps,
      JSONL_FILES.events,
      JSONL_FILES.manifest,
    ]) {
      expect(existsSync(join(runDir, name)), name).toBe(true);
    }

    const run = RunSchema.parse(JSON.parse(readFileSync(join(runDir, JSONL_FILES.run), 'utf8')));
    expect(run.status).toBe('completed');
    expect(run.counts).toEqual({
      planned: SIZE,
      running: 0,
      completed: SIZE,
      failed: 0,
      interrupted: 0,
    });
    expect(run.termination).toMatchObject({ kind: 'completed', lastCompletedStage: 'export' });
    expect(run.config.target.variants['control']?.url).toBe(control.url);
    expect(run.config.target.variants['treatment']?.url).toBe(treatment.url);

    sessions = readJsonl(join(runDir, JSONL_FILES.sessions), SessionSchema);
    expect(sessions).toHaveLength(SIZE);
    expect(sessions.map((s) => s.variant).sort()).toEqual(['control', 'treatment']);
    for (const session of sessions) {
      expect(session.outcome, `${session.id}: ${session.outcomeReason ?? ''}`).toBe('success');
      expect(['ops-manager', 'power-user']).toContain(session.persona.personaId);
      expect(session.metrics['activation']).toBe(1);
      expect(session.metrics['time_to_activate']).toBeGreaterThan(0);
    }
    const stepsOf = (variant: string): number =>
      sessions.find((s) => s.variant === variant)?.steps ?? Number.NaN;
    expect(stepsOf('treatment')).toBeLessThan(stepsOf('control'));

    const steps = readJsonl<Step>(join(runDir, JSONL_FILES.steps), StepSchema);
    expect(steps).toHaveLength(sessions.reduce((n, s) => n + s.steps, 0));
    expect(steps.every((s) => s.result.ok)).toBe(true);

    const events = readJsonl<AgonEvent>(join(runDir, JSONL_FILES.events), AgonEventSchema);
    for (const session of sessions) {
      const created = events.filter(
        (e) => e.sessionId === session.id && e.event === 'project_created',
      );
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ source: 'intercepted', provider: 'posthog' });
      expect(created[0]?.properties).toMatchObject({
        agon_simulated: true,
        agon_run_id: run.id,
        agon_variant: session.variant,
      });
    }

    const screenshots = readdirSync(join(runDir, 'screenshots')).filter((f) => f.endsWith('.png'));
    expect(screenshots).toHaveLength(steps.length);
    for (const name of screenshots) {
      const head = readFileSync(join(runDir, 'screenshots', name)).subarray(0, 8);
      expect(head.equals(PNG_SIGNATURE), name).toBe(true);
    }

    const printed = text();
    expect(printed).toContain(`completed: ${SIZE}/${SIZE} sessions`);
    expect(printed).toMatch(/control\s+1\s+100%/);
    expect(printed).toMatch(/treatment\s+1\s+100%/);
    expect(printed).toContain(`output: ${runDir}`);
    expect(sink.requests).toEqual([]);
  });

  it('agon trace lists the sessions and replays one step by step', () => {
    const list = capture(true);
    expect(traceCommand(list.out, { dir: outDir })).toBe(0);
    const listed = JSON.parse(list.text()) as { runDir: string; sessions: Session[] };
    expect(listed.runDir).toBe(runDir);
    expect(listed.sessions).toHaveLength(SIZE);

    const table = capture();
    expect(traceCommand(table.out, { dir: runDir })).toBe(0);
    for (const session of sessions) expect(table.text()).toContain(session.id);

    const first = sessions.find((s) => s.index === 0) as Session;
    const replay = capture();
    expect(traceCommand(replay.out, { dir: runDir, sessionId: '0' })).toBe(0);
    const text = replay.text();
    expect(text).toContain(`${first.id} · ${first.variant}`);
    expect(text).toContain(`#1  ${variantUrl(first.variant)}/`);
    expect(text).toContain(`#${first.steps}  ${variantUrl(first.variant)}/onboarding/project`);
    expect(text).toMatch(/does: {3}click e\d+ → ok, page changed/);
    expect(text).toMatch(/does: {3}fill e\d+ with "sim-[0-9a-f]+@example\.com" → ok/);
    expect(text).toContain('outcome: success (success criterion met)');
    expect(text).toMatch(
      /metrics: scenario_success=1, activation=1, time_to_activate=[\d.]+, steps=\d+/,
    );
  });

  const skipStats = process.env['AGON_SKIP_STATS_TESTS'] === '1';

  it.skipIf(skipStats)(
    'agon compare analyzes the run with agon-stats and shows the calibration note',
    async () => {
      const { out, text } = capture();
      expect(await compareCommand(out, { dir: outDir, minSessions: 1 }), text()).toBe(0);
      const resultPath = join(runDir, JSONL_FILES.result);
      expect(existsSync(resultPath)).toBe(true);
      const result: Result = ResultSchema.parse(JSON.parse(readFileSync(resultPath, 'utf8')));
      const run = RunSchema.parse(JSON.parse(readFileSync(join(runDir, JSONL_FILES.run), 'utf8')));
      expect(result.runId).toBe(run.id);
      expect(result.control).toBe('control');
      expect(result.primaryMetricId).toBe('activation');
      expect(result.sessionsAnalyzed).toBe(SIZE);
      expect(result.metrics.map((m) => m.metricId)).toEqual(
        expect.arrayContaining(['activation', 'steps']),
      );
      const steps = result.metrics.find((m) => m.metricId === 'steps');
      const mean = (variant: string): number =>
        steps?.variants.find((v) => v.variant === variant)?.mean ?? Number.NaN;
      expect(mean('treatment')).toBeLessThan(mean('control'));

      const printed = text();
      expect(printed).toMatch(/verdict: (SHIP|KILL|CONTINUE|INCONCLUSIVE)/);
      expect(printed).toContain('activation*');
      expect(printed).toContain(`calibration: ${result.calibration.profile}`);
      expect(printed).toContain(result.calibration.note);

      // the result is a receipt: a model, accepted under the run's requirements
      expect(result.kind).toBe('model');
      expect(result.assumptions.length).toBeGreaterThan(0);
      // the receipt names the requirements compare applied, --min-sessions 1 included
      const accepted = requirementsDigest({
        ...run.config,
        analysis: { ...run.config.analysis, minSessionsPerVariant: 1 },
      });
      expect(result.requirementsDigest).toBe(accepted);
      expect(printed).toContain(`receipt: model under requirements ${accepted.slice(0, 12)}`);
    },
  );
});
