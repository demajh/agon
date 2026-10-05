import { AgonConfigSchema, type AgonConfig, type AgonConfigInput } from '@agon/spec';

/** A valid config for the fake Ledgerly site. Override any part per test. */
export function testConfig(overrides: Partial<AgonConfigInput> = {}): AgonConfig {
  const base: AgonConfigInput = {
    version: 1,
    name: 'ledgerly-test',
    target: {
      kind: 'web',
      variants: {
        control: { url: 'http://control.test' },
        treatment: { url: 'http://treatment.test' },
      },
      capture: { analytics: ['posthog'], screenshots: 'never' },
    },
    personas: [
      {
        id: 'eager',
        name: 'Eager user',
        summary: 'You want this to work.',
        traits: { role: 'owner', patience: 0.9, attention: 0.9 },
      },
      {
        id: 'impatient',
        name: 'Impatient user',
        summary: 'You leave at the first sign of friction.',
        traits: { role: 'owner', patience: 0.1, attention: 0.2 },
      },
    ],
    population: { seed: 42, size: 4, personas: [{ use: 'eager', weight: 1 }], traitJitter: 0 },
    scenarios: [
      {
        id: 'first-project',
        goal: 'Sign up and create a first project.',
        success: 'event:project_created',
        maxSteps: 12,
        budgetUsd: 1,
      },
    ],
    metrics: [
      { id: 'activation', type: 'conversion', event: 'project_created', primary: true },
      { id: 'time_to_activate', type: 'duration', from: 'session_start', to: 'project_created' },
      { id: 'clicks', type: 'count', event: '$agon_click' },
      { id: 'steps', type: 'steps' },
    ],
    defaults: { model: 'fake/model-1', temperature: 0 },
  };
  return AgonConfigSchema.parse({ ...base, ...overrides });
}
