import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, FakeLlm, happyUser, ledgerlySite } from '@agon/engine/fakes';
import { describe, expect, it } from 'vitest';
import { Output } from '../output.js';
import { compareCommand } from './compare.js';
import { runCommand } from './run.js';
import { traceCommand } from './trace.js';

const CONFIG = `
version: 1
name: ledgerly-cli-test
target:
  kind: web
  variants:
    control: { url: http://control.test }
    treatment: { url: http://treatment.test }
  capture: { analytics: [posthog], screenshots: every_step }
personas:
  - id: eager
    name: Eager user
    summary: You want this to work.
    traits: { role: owner, patience: 0.9, attention: 0.9 }
population: { seed: 1, size: 4, personas: [{ use: eager }], traitJitter: 0 }
scenarios:
  - { id: first-project, goal: Sign up and create a project., success: event:project_created, maxSteps: 12 }
metrics:
  - { id: activation, type: conversion, event: project_created, primary: true }
  - { id: steps, type: steps }
defaults: { model: fake/model-1, temperature: 0 }
`;

function capture(json = false): { out: Output; text: () => string } {
  let text = '';
  const out = new Output({ json, color: false }, (t) => (text += t));
  return { out, text: () => text };
}

function setup(): { file: string; outDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agon-run-'));
  const file = join(dir, 'agon.yaml');
  writeFileSync(file, CONFIG);
  return { file, outDir: join(dir, 'out') };
}

describe('agon run + agon trace', () => {
  it('runs an experiment offline, records it, and trace reads it back', async () => {
    const { file, outDir } = setup();
    const { out, text } = capture();
    const code = await runCommand(
      out,
      { file, out: outDir, llmMode: 'off' },
      { llm: new FakeLlm(happyUser), adapter: new FakeAdapter(ledgerlySite) },
    );
    expect(code).toBe(0);
    const runDirs = readdirSync(outDir).filter((d) => d.startsWith('run_'));
    expect(runDirs).toHaveLength(1);
    const runDir = join(outDir, runDirs[0]!);
    const recorded = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
      termination: { kind: string; lastCompletedStage: string; capMs: number };
      counts: Record<string, number>;
    };
    expect(recorded.termination).toMatchObject({
      kind: 'completed',
      lastCompletedStage: 'export',
      capMs: 720_000,
    });
    expect(recorded.counts).toEqual({
      planned: 4,
      running: 0,
      completed: 4,
      failed: 0,
      interrupted: 0,
    });
    for (const f of [
      'run.json',
      'sessions.jsonl',
      'steps.jsonl',
      'events.jsonl',
      'manifest.json',
    ]) {
      expect(existsSync(join(runDir, f)), f).toBe(true);
    }
    expect(
      readdirSync(join(runDir, 'screenshots')).filter((f) => f.endsWith('.png')).length,
    ).toBeGreaterThan(0);
    expect(readFileSync(join(runDir, 'sessions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
    const printed = text();
    expect(printed).toContain('completed: 4/4 sessions');
    expect(printed).toMatch(/termination: completed after .*4\/4 sessions executed .* exit code 0/);
    expect(printed).toMatch(/control\s+2\s+100%/);
    expect(printed).toMatch(/treatment\s+2\s+100%/);
    expect(printed).toContain(`output: ${runDir}`);

    const list = capture(true);
    expect(traceCommand(list.out, { dir: outDir })).toBe(0);
    const listed = JSON.parse(list.text()) as { runDir: string; sessions: { id: string }[] };
    expect(listed.runDir).toBe(runDir);
    expect(listed.sessions).toHaveLength(4);

    const one = capture();
    expect(traceCommand(one.out, { dir: runDir, sessionId: '0' })).toBe(0);
    expect(one.text()).toContain('#1  http://');
    expect(one.text()).toContain('does:   click e1 → ok, page changed');
    expect(one.text()).toContain('outcome: success');
    expect(one.text()).toContain('metrics: scenario_success=1, activation=1');

    const missing = capture();
    expect(traceCommand(missing.out, { dir: runDir, sessionId: 'nope' })).toBe(1);
    expect(missing.text()).toMatch(/no session "nope"/);

    if (process.env['AGON_SKIP_STATS_TESTS'] !== '1') {
      const cmp = capture();
      expect(await compareCommand(cmp.out, { dir: outDir, minSessions: 1 })).toBe(0);
      expect(existsSync(join(runDir, 'result.json'))).toBe(true);
      expect(cmp.text()).toMatch(/verdict: (SHIP|KILL|CONTINUE|INCONCLUSIVE)/);
      expect(cmp.text()).toContain('activation*');
      expect(cmp.text()).toContain('calibration: uncalibrated-v0');
      expect(cmp.text()).toMatch(
        /trials: M=1 distinct treatment variant\(s\) against sample [0-9a-f]{12}/,
      );
      const asJson = capture(true);
      expect(await compareCommand(asJson.out, { dir: runDir })).toBe(0);
      const compared = JSON.parse(asJson.text()) as {
        result: { runId: string; decision: { rationale: string } };
        trials: number;
        sampleHash: string;
      };
      expect(compared.result.runId).toMatch(/^run_/);
      expect(compared.trials).toBe(1);
      expect(compared.sampleHash).toMatch(/^[0-9a-f]{64}$/);
      expect(compared.result.decision.rationale).toContain('Trials: M=1');
      expect(compared.result.decision.rationale).toContain(
        `sample ${compared.sampleHash.slice(0, 12)}`,
      );
    }
  }, 120_000);

  it('dry runs write only the run record', async () => {
    const { file, outDir } = setup();
    const { out, text } = capture(true);
    const code = await runCommand(
      out,
      { file, out: outDir, dryRun: true, variants: ['treatment'], size: 3 },
      { llm: new FakeLlm(happyUser), adapter: new FakeAdapter(ledgerlySite) },
    );
    expect(code).toBe(0);
    const result = JSON.parse(text()) as {
      planned: number;
      counts: { completed: number };
      runDir: string;
      termination: { kind: string; lastCompletedStage: string };
      exitCode: number;
    };
    expect(result.planned).toBe(3);
    expect(result.counts.completed).toBe(0);
    expect(result.termination).toMatchObject({ kind: 'completed', lastCompletedStage: 'setup' });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.runDir, 'run.json'))).toBe(true);
    const stepsFile = join(result.runDir, 'steps.jsonl');
    expect(existsSync(stepsFile) ? statSync(stepsFile).size : 0).toBe(0);
  });

  it('fails cleanly on an invalid config or llm mode', async () => {
    const { file, outDir } = setup();
    writeFileSync(file, CONFIG.replace('size: 4', 'size: 0'));
    const bad = capture();
    expect(
      await runCommand(
        bad.out,
        { file, out: outDir },
        { llm: new FakeLlm(happyUser), adapter: new FakeAdapter() },
      ),
    ).toBe(1);
    expect(bad.text()).toMatch(/✗/);
    writeFileSync(file, CONFIG);
    const mode = capture();
    expect(
      await runCommand(
        mode.out,
        { file, out: outDir, llmMode: 'turbo' },
        { llm: new FakeLlm(happyUser), adapter: new FakeAdapter() },
      ),
    ).toBe(1);
    expect(mode.text()).toMatch(/--llm-mode must be one of/);
  });

  it('ends with the dedicated exit code and a partial outcome when the time cap is reached', async () => {
    const { file, outDir } = setup();
    const { out, text } = capture(true);
    // The clock started twelve minutes ago: the default cap has already elapsed.
    const code = await runCommand(
      out,
      { file, out: outDir, llmMode: 'off' },
      {
        llm: new FakeLlm(happyUser),
        adapter: new FakeAdapter(ledgerlySite),
        now: () => Date.now() - 720_000,
      },
    );
    expect(code).toBe(3);
    const result = JSON.parse(text()) as {
      status: string;
      exitCode: number;
      runDir: string;
      termination: {
        kind: string;
        lastCompletedStage: string;
        sessionsExecuted: number;
        sessionsPlanned: number;
        partialDeltaManifest: { exportsWritten: string[] };
      };
    };
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(3);
    expect(result.termination).toMatchObject({
      kind: 'time_cap_reached',
      lastCompletedStage: 'export',
      sessionsExecuted: 0,
      sessionsPlanned: 4,
    });
    expect(result.termination.partialDeltaManifest.exportsWritten).toEqual([`jsonl:${outDir}`]);
    const recorded = JSON.parse(readFileSync(join(result.runDir, 'run.json'), 'utf8')) as {
      termination: { kind: string; lastCompletedStage: string };
    };
    expect(recorded.termination).toMatchObject({
      kind: 'time_cap_reached',
      lastCompletedStage: 'export',
    });

    const explicit = capture(true);
    expect(
      await runCommand(
        explicit.out,
        { file, out: outDir, llmMode: 'off', timeCapMs: 60_000 },
        { llm: new FakeLlm(happyUser), adapter: new FakeAdapter(ledgerlySite) },
      ),
    ).toBe(0);
    expect(
      (JSON.parse(explicit.text()) as { termination: { capMs: number } }).termination.capMs,
    ).toBe(60_000);
  });
});
