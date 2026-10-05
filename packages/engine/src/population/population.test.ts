import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../testing/config.js';
import { findBuiltinPersonaDir, loadPersonaDir, resolvePersonas } from './personas.js';
import { planSessions } from './sampler.js';

describe('built-in persona library', () => {
  it('is found from the source tree and every file validates', () => {
    const dir = findBuiltinPersonaDir();
    expect(dir).toBeDefined();
    const lib = loadPersonaDir(dir!);
    expect([...lib.keys()]).toEqual(
      expect.arrayContaining([
        'smb-owner',
        'developer-evaluator',
        'skeptical-cfo',
        'first-time-founder',
      ]),
    );
    expect(lib.get('first-time-founder')?.device).toBe('mobile');
  });
});

describe('resolvePersonas', () => {
  it('resolves builtin, file and inline references with weights', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agon-personas-'));
    writeFileSync(
      join(dir, 'custom.yaml'),
      'id: custom\nname: Custom\nsummary: You are custom.\ntraits:\n  role: tester\n',
    );
    const cfg = testConfig({
      population: {
        size: 3,
        personas: [
          { use: 'builtin/smb-owner', weight: 2 },
          { use: './custom.yaml', weight: 1 },
          { use: 'eager', weight: 0.5 },
        ],
      },
    });
    const resolved = resolvePersonas(cfg, { cwd: dir });
    expect(resolved.map((r) => [r.persona.id, r.weight, r.source])).toEqual([
      ['smb-owner', 2, 'builtin'],
      ['custom', 1, 'file'],
      ['eager', 0.5, 'inline'],
    ]);
  });

  it('names the available builtins when one is missing', () => {
    const cfg = testConfig({ population: { size: 1, personas: [{ use: 'builtin/nobody' }] } });
    expect(() => resolvePersonas(cfg)).toThrow(ConfigError);
    expect(() => resolvePersonas(cfg)).toThrow(
      /unknown built-in persona "nobody" \(available: .*smb-owner/,
    );
  });
});

describe('planSessions', () => {
  const cfg = testConfig({
    population: {
      seed: 9,
      size: 200,
      models: ['fake/a', 'fake/b'],
      personas: [
        { use: 'eager', weight: 3 },
        { use: 'impatient', weight: 1 },
      ],
      traitJitter: 0.1,
    },
  });
  const personas = resolvePersonas(cfg);
  const opts = {
    runId: 'run_test123',
    variants: ['control', 'treatment'],
    seed: 9,
    size: 200,
    defaultModel: 'fake/default',
  };

  it('is deterministic for the same inputs and changes with the seed', () => {
    const a = planSessions(cfg, personas, opts);
    const b = planSessions(cfg, personas, opts);
    expect(a).toEqual(b);
    const c = planSessions(cfg, personas, { ...opts, seed: 10 });
    expect(c.map((p) => p.persona.personaId)).not.toEqual(a.map((p) => p.persona.personaId));
  });

  it('balances variants exactly, follows persona weights, spreads models, and jitters traits', () => {
    const plans = planSessions(cfg, personas, opts);
    expect(plans).toHaveLength(200);
    const byVariant = plans.reduce<Record<string, number>>(
      (acc, p) => ({ ...acc, [p.variant]: (acc[p.variant] ?? 0) + 1 }),
      {},
    );
    expect(byVariant).toEqual({ control: 100, treatment: 100 });
    const eager = plans.filter((p) => p.persona.personaId === 'eager').length;
    expect(eager / 200).toBeGreaterThan(0.65);
    expect(eager / 200).toBeLessThan(0.85);
    expect(new Set(plans.map((p) => p.persona.model))).toEqual(new Set(['fake/a', 'fake/b']));
    const patiences = new Set(
      plans.filter((p) => p.persona.personaId === 'eager').map((p) => p.persona.traits.patience),
    );
    expect(patiences.size).toBeGreaterThan(10);
    for (const p of plans) {
      expect(p.persona.traits.patience).toBeGreaterThanOrEqual(0);
      expect(p.persona.traits.patience).toBeLessThanOrEqual(1);
      expect(p.persona.traits.role).toBe('owner');
    }
    expect(new Set(plans.map((p) => p.persona.distinctId)).size).toBe(200);
    expect(plans[0]?.sessionId).toBe('ses_test123_00000');
    expect(plans[0]?.persona.distinctId).toBe('sim_test123_00000');
  });

  it('falls back to the default model when the population lists none', () => {
    const plans = planSessions(testConfig(), resolvePersonas(testConfig()), { ...opts, size: 3 });
    expect(plans.every((p) => p.persona.model === 'fake/default')).toBe(true);
  });
});
