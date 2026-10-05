import { describe, expect, it } from 'vitest';
import {
  AgonError,
  NotFoundError,
  SuccessCriterionInputSchema,
  deterministicId,
  durationToMs,
  isAgonError,
  metricDirection,
  newId,
  parseModelRef,
  parseSuccessShorthand,
  policyApproval,
} from './index.js';

describe('ids and durations', () => {
  it('newId uses the prefix and base36 alphabet', () => {
    expect(newId('run')).toMatch(/^run_[0-9a-z]{16}$/);
    expect(newId('run')).not.toBe(newId('run'));
  });
  it('deterministicId derives from the parent and index', () => {
    expect(deterministicId('ses', 'run_abc123', 42)).toBe('ses_abc123_00042');
    expect(deterministicId('stp', 'ses_abc123_00042', 3, 3)).toBe('stp_abc123_00042_003');
  });
  it('durationToMs handles every unit', () => {
    expect(durationToMs('500ms')).toBe(500);
    expect(durationToMs('30s')).toBe(30_000);
    expect(durationToMs('15m')).toBe(900_000);
    expect(durationToMs('24h')).toBe(86_400_000);
    expect(durationToMs('7d')).toBe(604_800_000);
  });
  it('parseModelRef splits provider and model', () => {
    expect(parseModelRef('anthropic/claude-sonnet-5-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
  });
});

describe('success criteria', () => {
  it('parses shorthand forms', () => {
    expect(parseSuccessShorthand('event:signup')).toEqual({ type: 'event', name: 'signup' });
    expect(parseSuccessShorthand('url:/dashboard')).toEqual({ type: 'url', pattern: '/dashboard' });
    expect(parseSuccessShorthand('text:Welcome aboard')).toEqual({ type: 'text', contains: 'Welcome aboard' });
    expect(parseSuccessShorthand('judge')).toEqual({ type: 'judge' });
    expect(() => parseSuccessShorthand('nope')).toThrow(/invalid success criterion/);
  });
  it('accepts object form through the input schema', () => {
    expect(SuccessCriterionInputSchema.parse({ type: 'url', pattern: '**/done' })).toEqual({
      type: 'url',
      pattern: '**/done',
    });
    expect(SuccessCriterionInputSchema.safeParse('bogus').success).toBe(false);
  });
});

describe('defaults that encode policy', () => {
  it('metricDirection: durations, steps and frustration are lower-is-better', () => {
    expect(metricDirection({ id: 'a', type: 'conversion', event: 'x', primary: false })).toBe('increase');
    expect(metricDirection({ id: 'b', type: 'duration', from: 'session_start', to: 'x', primary: false })).toBe('decrease');
    expect(metricDirection({ id: 'c', type: 'steps', primary: false })).toBe('decrease');
    expect(
      metricDirection({ id: 'd', type: 'score', source: 'judge', score: 'frustration', primary: false }),
    ).toBe('decrease');
    expect(
      metricDirection({ id: 'e', type: 'score', source: 'judge', score: 'satisfaction', primary: false }),
    ).toBe('increase');
  });
  it('policyApproval: destructive actions need a human unless stated otherwise', () => {
    const base = { id: 'p', on: 'result.ready', method: 'thompson', floor: 0.1, cooldown: '24h', maxPerDay: 5 } as const;
    expect(policyApproval({ ...base, then: 'kill' })).toBe('human');
    expect(policyApproval({ ...base, then: 'pause' })).toBe('human');
    expect(policyApproval({ ...base, then: 'reallocate' })).toBe('auto');
    expect(policyApproval({ ...base, then: 'kill', approval: 'auto' })).toBe('auto');
  });
});

describe('errors', () => {
  it('carry stable codes and serialize for the API', () => {
    const err = new NotFoundError('run', 'run_x');
    expect(isAgonError(err)).toBe(true);
    expect(err).toBeInstanceOf(AgonError);
    expect(err.status).toBe(404);
    expect(err.toJSON()).toEqual({
      error: { code: 'not_found', message: 'run not found: run_x', details: { resource: 'run', id: 'run_x' } },
    });
  });
});
