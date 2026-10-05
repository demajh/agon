import type { Observation, PersonaTraits } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { DEFAULT_PATIENCE, initialPatience, shouldAbandon, updatePatience } from './patience.js';
import { perceptionLimits, pruneObservation } from './perception.js';
import { buildStepMessage, buildSystemPrompt, renderObservation } from './prompts.js';

const traits = (patience: number, attention = 0.5): PersonaTraits => ({
  role: 'owner',
  techProficiency: 'intermediate',
  patience,
  attention,
  domainFamiliarity: 0.5,
  riskTolerance: 0.5,
  priceSensitivity: 0.5,
});

describe('patience model', () => {
  it('starts higher for patient personas and never leaves [0,1]', () => {
    expect(initialPatience(traits(0))).toBeCloseTo(0.35);
    expect(initialPatience(traits(1))).toBeCloseTo(1);
    expect(initialPatience(traits(0.5))).toBeGreaterThan(initialPatience(traits(0.2)));
  });

  it('drains faster for impatient personas on no progress, recovers on progress', () => {
    const base = { feeling: 'neutral' as const, errors: 0, actionOk: true };
    const impatient = updatePatience(0.8, { traits: traits(0.1), progress: 'none', ...base });
    const patient = updatePatience(0.8, { traits: traits(0.9), progress: 'none', ...base });
    expect(impatient).toBeLessThan(patient);
    expect(
      updatePatience(0.5, { traits: traits(0.5), progress: 'progress', ...base }),
    ).toBeGreaterThan(0.5);
    expect(
      updatePatience(0.5, {
        traits: traits(0.5),
        progress: 'regress',
        feeling: 'frustrated',
        errors: 2,
        actionOk: false,
      }),
    ).toBeLessThan(updatePatience(0.5, { traits: traits(0.5), progress: 'none', ...base }));
    expect(
      updatePatience(0.01, {
        traits: traits(0),
        progress: 'regress',
        feeling: 'frustrated',
        errors: 5,
        actionOk: false,
      }),
    ).toBe(0);
  });

  it('abandons with certainty at zero, never above the threshold, stochastically in between', () => {
    const rng = createRng(1);
    expect(shouldAbandon(0, rng)).toBe(true);
    expect(shouldAbandon(0.5, rng)).toBe(false);
    let abandoned = 0;
    for (let i = 0; i < 2000; i++) if (shouldAbandon(0.1, rng)) abandoned++;
    const expected =
      ((DEFAULT_PATIENCE.abandonBelow - 0.1) / DEFAULT_PATIENCE.abandonBelow) *
      DEFAULT_PATIENCE.abandonSlope;
    expect(abandoned / 2000).toBeCloseTo(expected, 1);
  });
});

const observation: Observation = {
  url: 'http://x.test/signup?ref=1',
  title: 'Sign up',
  text: 'word '.repeat(2000).trim(),
  interactive: Array.from({ length: 60 }, (_, i) => ({
    ref: `e${i}`,
    role: 'button',
    name: `Button ${i}`,
    disabled: false,
  })),
  errors: ['Email is invalid'],
  truncated: false,
  hash: 'h',
  capturedAt: '2026-10-04T00:00:00.000Z',
};

describe('perception', () => {
  it('scales limits with attention and prunes observations idempotently', () => {
    expect(perceptionLimits(traits(0.5, 0)).maxInteractive).toBe(8);
    expect(perceptionLimits(traits(0.5, 1)).maxInteractive).toBe(40);
    expect(perceptionLimits(traits(0.5, 1)).maxTextChars).toBe(4000);
    const pruned = pruneObservation(observation, { maxTextChars: 100, maxInteractive: 10 });
    expect(pruned.text.length).toBeLessThanOrEqual(102);
    expect(pruned.text.endsWith('…')).toBe(true);
    expect(pruned.interactive).toHaveLength(10);
    expect(pruned.truncated).toBe(true);
    expect(pruneObservation(pruned, { maxTextChars: 100, maxInteractive: 10 })).toEqual(pruned);
    const untouched = pruneObservation(observation, { maxTextChars: 1e6, maxInteractive: 1e6 });
    expect(untouched.truncated).toBe(false);
  });
});

describe('prompts', () => {
  it('render the persona, situation, credentials, refs and errors', () => {
    const system = buildSystemPrompt({
      persona: {
        personaId: 'p',
        name: 'Pat',
        summary: 'You run a bakery.',
        traits: traits(0.2, 0.2),
        goals: ['see the price'],
        frustrations: ['jargon'],
        device: 'mobile',
        locale: 'en-GB',
        model: 'fake/m',
        seed: 1,
        distinctId: 'sim_1',
      },
      scenario: {
        id: 's',
        goal: 'Find out what it costs.',
        success: { type: 'judge' },
        startPath: '/',
        maxSteps: 10,
        budgetUsd: 1,
        weight: 1,
        context: { promo: 'SPRING' },
      },
      credentials: { email: 'pat@example.com', password: 'pw' },
    });
    expect(system).toContain('You run a bakery.');
    expect(system).toContain('Patience: low');
    expect(system).toContain('skim headlines');
    expect(system).toContain('promo = SPRING');
    expect(system).toContain('email = pat@example.com');
    expect(system).toContain('give_up');

    const rendered = renderObservation(observation);
    expect(rendered).toContain('URL: http://x.test/signup?ref=1');
    expect(rendered).toContain('[e0] button "Button 0"');
    expect(rendered).toContain('- Email is invalid');

    const message = buildStepMessage({
      stepIndex: 2,
      maxSteps: 10,
      patience: 0.1,
      lastAction: { type: 'click', ref: 'e1' },
      lastResult: { ok: false, error: 'nope', navigated: false },
      history: ['1. click e0 → none, felt confused'],
      observation,
    });
    expect(message).toContain('Step 3');
    expect(message).toContain('about to give up');
    expect(message).toContain('it failed: nope');
    expect(message).toContain('1. click e0 → none');
    expect(message).toContain('Actions: click(ref)');
  });
});
