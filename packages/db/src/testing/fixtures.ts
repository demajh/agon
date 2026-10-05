import {
  AgonConfigSchema,
  AgonEventSchema,
  PersonaTraitsSchema,
  ResultSchema,
  RunSchema,
  SessionSchema,
  StepSchema,
  deterministicId,
  newId,
  simProperties,
} from '@agon/spec';
import type {
  AgonConfig,
  AgonEvent,
  PersonaInstance,
  Result,
  Run,
  Session,
  Step,
} from '@agon/spec';

export const MODEL = 'anthropic/claude-sonnet-5-5';
export const T0 = '2026-10-04T17:00:00.000Z';

/** `T0` plus whole seconds: distinct, ordered, millisecond-exact timestamps that survive a round trip. */
export function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** A small but complete `agon.yaml`, with every default applied. */
export const config: AgonConfig = AgonConfigSchema.parse({
  version: 1,
  name: 'onboarding-redesign',
  description: 'Does the shorter onboarding flow activate more new users?',
  target: {
    kind: 'web',
    variants: {
      control: { url: 'https://app.example.com' },
      treatment: { url: 'https://pr-123.example.app', squad: 'squad-blue' },
    },
    capture: { analytics: ['posthog'] },
  },
  population: {
    seed: 7,
    size: 4,
    models: [MODEL],
    personas: [{ use: 'builtin/smb-owner', weight: 1 }],
  },
  scenarios: [
    {
      id: 'first-project',
      goal: 'Decide whether this product is worth trying; if so, sign up and create a first project.',
      success: 'event:project_created',
      maxSteps: 10,
    },
  ],
  metrics: [{ id: 'activation', type: 'conversion', event: 'project_created', primary: true }],
});

export function makeRun(environmentId: string, overrides: Partial<Run> = {}): Run {
  return RunSchema.parse({
    id: newId('run'),
    environmentId,
    status: 'queued',
    variants: ['control', 'treatment'],
    seed: 7,
    config,
    createdAt: at(0),
    ...overrides,
  });
}

export function makePersona(seed: number): PersonaInstance {
  return {
    personaId: 'smb-owner',
    name: 'SMB owner',
    summary: 'You run a twelve-person agency and are evaluating this tool for your team.',
    traits: PersonaTraitsSchema.parse({ role: 'owner of a 12-person agency', patience: 0.4 }),
    goals: ['find out whether this is worth trying'],
    frustrations: ['mandatory demos'],
    device: 'desktop',
    locale: 'en-US',
    model: MODEL,
    seed,
    distinctId: `sim_user_${seed}`,
  };
}

export function makeSession(run: Run, index: number, overrides: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    id: deterministicId('ses', run.id, index),
    runId: run.id,
    index,
    variant: run.variants[index % run.variants.length] ?? 'control',
    scenarioId: 'first-project',
    persona: makePersona(index),
    status: 'running',
    startedAt: at(index),
    ...overrides,
  });
}

export function makeStep(session: Session, index: number, overrides: Partial<Step> = {}): Step {
  return StepSchema.parse({
    id: deterministicId('stp', session.id, index, 3),
    sessionId: session.id,
    index,
    observation: {
      url: 'https://app.example.com/',
      title: 'Home',
      text: 'Welcome. Sign up to create your first project.',
      interactive: [{ ref: 'e1', role: 'button', name: 'Sign up' }],
      hash: `obs_${index}`,
      capturedAt: at(100 + index),
    },
    decision: {
      perception: 'A landing page with a prominent sign-up button.',
      thinking: 'Signing up is the only way to find out what this does.',
      feeling: 'neutral',
      progress: 'progress',
      action: { type: 'click', ref: 'e1' },
    },
    result: { ok: true, navigated: true },
    patience: 0.9,
    usage: { model: MODEL, inputTokens: 1200, outputTokens: 80, costUsd: 0.004, latencyMs: 900 },
    startedAt: at(100 + index),
    durationMs: 1500,
    ...overrides,
  });
}

export function makeEvent(
  session: Session,
  index: number,
  name = 'project_created',
  overrides: Partial<AgonEvent> = {},
): AgonEvent {
  return AgonEventSchema.parse({
    id: deterministicId('evt', session.id, index, 3),
    runId: session.runId,
    sessionId: session.id,
    timestamp: at(200 + index),
    event: name,
    distinctId: session.persona.distinctId,
    source: 'intercepted',
    provider: 'posthog',
    properties: {
      ...simProperties({
        runId: session.runId,
        sessionId: session.id,
        variant: session.variant,
        personaId: session.persona.personaId,
        model: session.persona.model,
        scenarioId: session.scenarioId,
      }),
      plan: 'pro',
    },
    ...overrides,
  });
}

export function makeResult(run: Run, overrides: Partial<Result> = {}): Result {
  return ResultSchema.parse({
    id: newId('res'),
    runId: run.id,
    method: 'bayesian',
    control: 'control',
    primaryMetricId: 'activation',
    metrics: [
      {
        metricId: 'activation',
        direction: 'increase',
        variants: [
          { variant: 'control', sessions: 2, successes: 1, mean: 0.5, stderr: 0.35, ci95: [0, 1] },
          { variant: 'treatment', sessions: 2, successes: 2, mean: 1, stderr: 0, ci95: [1, 1] },
        ],
        comparisons: [
          {
            variant: 'treatment',
            control: 'control',
            lift: 1,
            liftCi95: [-0.5, 2.5],
            pBest: 0.7,
            pBeatControl: 0.7,
            expectedLoss: 0.05,
          },
        ],
        warnings: ['fewer than 30 sessions per variant'],
      },
    ],
    decision: { verdict: 'continue', rationale: 'Too few sessions to decide.' },
    calibration: {
      profile: 'uncalibrated-v0',
      note: 'Simulated users; direction accuracy for this change category is not yet benchmarked.',
    },
    sessionsAnalyzed: 4,
    computedAt: at(300),
    engine: { name: 'agon-stats', version: '0.0.1' },
    ...overrides,
  });
}
