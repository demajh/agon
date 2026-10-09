import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgonConfigSchema, SessionSchema, requirementsDigest, type Session } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  allocateSquads,
  analyzeSessions,
  buildAnalysisConfig,
  resolveStatsBinary,
  statsVersion,
} from './index.js';

const config = AgonConfigSchema.parse({
  version: 1,
  name: 'demo',
  target: { variants: { control: { url: 'http://a.test' }, treatment: { url: 'http://b.test' } } },
  population: { size: 40, personas: [{ use: 'builtin/smb-owner' }] },
  scenarios: [{ id: 's', goal: 'g', success: 'event:project_created' }],
  metrics: [
    { id: 'activation', type: 'conversion', event: 'project_created', primary: true },
    { id: 'steps', type: 'steps' },
  ],
  analysis: { minSessionsPerVariant: 10 },
});

function session(i: number, variant: string, success: boolean): Session {
  const at = new Date(Date.UTC(2026, 9, 4, 0, 0, i)).toISOString();
  return SessionSchema.parse({
    id: `ses_t_${String(i).padStart(5, '0')}`,
    runId: 'run_t',
    index: i,
    variant,
    scenarioId: 's',
    persona: {
      personaId: i % 3 === 0 ? 'cautious' : 'eager',
      name: 'x',
      summary: 'x',
      traits: {
        role: 'owner',
        techProficiency: 'intermediate',
        patience: 0.5,
        attention: 0.5,
        domainFamiliarity: 0.5,
        riskTolerance: 0.5,
        priceSensitivity: 0.5,
      },
      goals: [],
      frustrations: [],
      device: 'desktop',
      locale: 'en-US',
      model: i % 2 ? 'fake/a' : 'fake/b',
      seed: i,
      distinctId: `sim_${i}`,
    },
    status: 'finished',
    outcome: success ? 'success' : 'gave_up',
    steps: success ? 5 : 3,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 10,
    metrics: {
      scenario_success: success ? 1 : 0,
      activation: success ? 1 : 0,
      steps: success ? 5 : 3,
    },
    startedAt: at,
    finishedAt: at,
  });
}

function writeSessions(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agon-stats-client-'));
  const rows: Session[] = [];
  for (let i = 0; i < 80; i++) {
    const variant = i % 2 ? 'treatment' : 'control';
    const success = variant === 'control' ? i % 10 < 3 : i % 10 < 8;
    rows.push(session(i, variant, success));
  }
  const path = join(dir, 'sessions.jsonl');
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

describe('buildAnalysisConfig', () => {
  it('mirrors the config analysis block, resolves the control, and applies overrides', () => {
    const analysis = buildAnalysisConfig(config, { id: 'run_x', seed: 7 });
    expect(analysis).toMatchObject({
      runId: 'run_x',
      control: 'control',
      method: 'bayesian',
      minSessionsPerVariant: 10,
      seed: 7,
      calibrationProfile: 'uncalibrated-v0',
    });
    expect(analysis.metrics).toHaveLength(2);
    expect(
      buildAnalysisConfig(
        config,
        { id: 'run_x', seed: 7 },
        { control: 'treatment', method: 'fixed', changeCategory: 'flow' },
      ),
    ).toMatchObject({ control: 'treatment', method: 'fixed', changeCategory: 'flow' });
    expect(() =>
      buildAnalysisConfig(config, { id: 'run_x', seed: 7 }, { control: 'nope' }),
    ).toThrow(/control "nope"/);
  });

  it('digests the requirements the result is accepted under, overrides included', () => {
    const plain = buildAnalysisConfig(config, { id: 'run_x', seed: 7 });
    expect(plain.requirementsDigest).toBe(requirementsDigest(config));
    // the seed and the change category do not decide acceptance
    expect(
      buildAnalysisConfig(config, { id: 'run_y', seed: 9 }, { seed: 3, changeCategory: 'copy' })
        .requirementsDigest,
    ).toBe(plain.requirementsDigest);
    const fixed = buildAnalysisConfig(config, { id: 'run_x', seed: 7 }, { method: 'fixed' });
    expect(fixed.requirementsDigest).toBe(
      requirementsDigest({ ...config, analysis: { ...config.analysis, method: 'fixed' } }),
    );
    expect(fixed.requirementsDigest).not.toBe(plain.requirementsDigest);
    expect(
      buildAnalysisConfig(config, { id: 'run_x', seed: 7 }, { minSessionsPerVariant: 1 })
        .requirementsDigest,
    ).not.toBe(plain.requirementsDigest);
  });
});

describe('resolveStatsBinary', () => {
  it('honours AGON_STATS_BIN and falls back to the monorepo uv project', () => {
    expect(resolveStatsBinary({ env: { AGON_STATS_BIN: 'uv run agon-stats', PATH: '' } })).toEqual({
      command: 'uv',
      args: ['run', 'agon-stats'],
      source: 'env',
    });
    const resolved = resolveStatsBinary();
    expect(['path', 'uv-project']).toContain(resolved.source);
    expect(() => resolveStatsBinary({ env: { PATH: '/nonexistent' } })).toThrow(
      /agon-stats not found/,
    );
  });
});

const skip = process.env['AGON_SKIP_STATS_TESTS'] === '1';

describe.skipIf(skip)('agon-stats subprocess', () => {
  it('reports its version', async () => {
    expect(await statsVersion()).toMatch(/^agon-stats \d+\.\d+\.\d+/);
  }, 120_000);

  it('analyzes sessions into a spec Result and writes result.json', async () => {
    const sessionsPath = writeSessions();
    const outPath = join(sessionsPath, '..', 'result.json');
    const result = await analyzeSessions(
      { sessionsPath, analysis: buildAnalysisConfig(config, { id: 'run_t', seed: 1 }), outPath },
      {},
    );
    expect(result.runId).toBe('run_t');
    expect(result.control).toBe('control');
    expect(result.primaryMetricId).toBe('activation');
    expect(result.sessionsAnalyzed).toBe(80);
    expect(result.metrics.map((m) => m.metricId)).toEqual([
      'scenario_success',
      'activation',
      'steps',
    ]);
    const activation = result.metrics.find((m) => m.metricId === 'activation')!;
    const treatment = activation.comparisons.find((c) => c.variant === 'treatment')!;
    expect(treatment.pBest).toBeGreaterThan(0.95);
    // control succeeds for 2 of every 5 sessions, treatment for 4 of 5: lift = (0.8 - 0.4) / 0.4
    expect(activation.variants.find((v) => v.variant === 'control')?.mean).toBeCloseTo(0.4, 6);
    expect(activation.variants.find((v) => v.variant === 'treatment')?.mean).toBeCloseTo(0.8, 6);
    expect(treatment.lift).toBeCloseTo(1, 6);
    expect(result.decision.verdict).toBe('ship');
    expect(result.decision.variant).toBe('treatment');
    expect(result.calibration.profile).toBe('uncalibrated-v0');
    expect(result.calibration.note.length).toBeGreaterThan(10);
    expect(JSON.parse((await import('node:fs')).readFileSync(outPath, 'utf8')).id).toBe(result.id);
  }, 120_000);

  it('turns stats errors into AgonErrors', async () => {
    const sessionsPath = writeSessions();
    await expect(
      analyzeSessions({
        sessionsPath,
        analysis: { ...buildAnalysisConfig(config, { id: 'run_t', seed: 1 }), control: 'ghost' },
      }),
    ).rejects.toThrow(/agon-stats/);
  }, 120_000);

  it('allocates squads with a floor', async () => {
    const allocation = await allocateSquads(
      [
        { squad: 'blue', wins: 8, runs: 10 },
        { squad: 'red', wins: 1, runs: 10 },
      ],
      { floor: 0.1, seed: 0 },
    );
    const total = Object.values(allocation).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(allocation['blue']!).toBeGreaterThan(allocation['red']!);
    expect(allocation['red']!).toBeGreaterThanOrEqual(0.1 - 1e-9);
  }, 120_000);
});
