import { createWebAdapter } from '@agon/adapters';
import type { WebAdapter } from '@agon/adapters';
import { runExperiment } from '@agon/engine';
import type { RunOutcome } from '@agon/engine';
import { FakeLlm, MemoryRecorder } from '@agon/engine/fakes';
import {
  AgonConfigSchema,
  AgonEventSchema,
  INFERRED_EVENTS,
  SCENARIO_SUCCESS_METRIC_ID,
  SIM_PROPERTY_KEYS,
  SimPropertiesSchema,
} from '@agon/spec';
import type { AgonConfig, AgonEvent, Session } from '@agon/spec';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoAppEvents, startAnalyticsSink, startDemoApp } from './demo.js';
import type { AnalyticsSink, RunningServer } from './demo.js';
import { ledgerlyUser } from './ledgerly-user.js';

const RUN_ID = 'run_e2e';
const MODEL = 'fake/model';
const SIZE = 4;

let sink: AnalyticsSink;
let control: RunningServer;
let treatment: RunningServer;
let adapter: WebAdapter;
let config: AgonConfig;
const recorder = new MemoryRecorder();
const llm = new FakeLlm(ledgerlyUser);
let outcome: RunOutcome;

const byVariant = (variant: string): Session[] =>
  outcome.sessions.filter((s) => s.variant === variant);
const eventsOf = (session: Session, name?: string): AgonEvent[] =>
  recorder.recordedEvents.filter(
    (e) => e.sessionId === session.id && (name === undefined || e.event === name),
  );
const stepsOf = (session: Session) =>
  recorder.steps.filter((s) => s.step.sessionId === session.id).map((s) => s.step);
const variantUrl = (variant: string): string => (variant === 'control' ? control : treatment).url;

beforeAll(async () => {
  sink = await startAnalyticsSink();
  [control, treatment] = await Promise.all([
    startDemoApp('control', { posthogHost: sink.url }),
    startDemoApp('treatment', { posthogHost: sink.url }),
  ]);
  adapter = createWebAdapter({ headless: true });
  config = AgonConfigSchema.parse({
    version: 1,
    name: 'ledgerly-e2e',
    description: 'The real demo app, the real browser adapter, a scripted user.',
    target: {
      kind: 'web',
      variants: {
        control: { url: control.url, description: 'five onboarding steps' },
        treatment: { url: treatment.url, description: 'one onboarding step' },
      },
      capture: { analytics: ['posthog'], screenshots: 'never' },
    },
    personas: [
      {
        id: 'eager-owner',
        name: 'Eager owner',
        summary: 'You run a small coffee shop and want your books sorted tonight.',
        traits: { role: 'owner of a small cafe', patience: 0.9, attention: 0.9 },
      },
      {
        id: 'thorough-bookkeeper',
        name: 'Thorough bookkeeper',
        summary: 'You keep books for several clients and read every form before you fill it.',
        traits: {
          role: 'freelance bookkeeper',
          techProficiency: 'expert',
          patience: 0.95,
          attention: 1,
        },
        device: 'mobile',
      },
    ],
    population: {
      seed: 11,
      size: SIZE,
      personas: [
        { use: 'eager-owner', weight: 1 },
        { use: 'thorough-bookkeeper', weight: 1 },
      ],
      traitJitter: 0,
    },
    scenarios: [
      {
        id: 'first-project',
        goal: 'You just heard about Ledgerly. Sign up and create your first project.',
        success: 'event:project_created',
        maxSteps: 25,
      },
    ],
    metrics: [
      { id: 'activation', type: 'conversion', event: 'project_created', primary: true },
      { id: 'steps', type: 'steps' },
    ],
    defaults: { model: MODEL, maxConcurrency: 2 },
  });
});

afterAll(async () => {
  await adapter?.dispose();
  await Promise.all([control?.close(), treatment?.close(), sink?.close()]);
});

describe('runExperiment against the live demo app through the Playwright adapter', () => {
  it('completes every planned session in both variants with the success criterion met', async () => {
    outcome = await runExperiment(
      config,
      { runId: RUN_ID },
      {
        llm,
        adapters: { web: adapter },
        recorder,
        logger: pino({ level: 'silent' }),
      },
    );

    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.counts).toEqual({ planned: SIZE, running: 0, completed: SIZE, failed: 0 });
    expect(outcome.sessions).toHaveLength(SIZE);
    expect(byVariant('control')).toHaveLength(SIZE / 2);
    expect(byVariant('treatment')).toHaveLength(SIZE / 2);
    for (const session of outcome.sessions) {
      expect(session.status, session.id).toBe('finished');
      expect(session.outcome, `${session.id}: ${session.outcomeReason ?? ''}`).toBe('success');
      expect(session.error).toBeUndefined();
    }
    expect(recorder.calls[0]).toBe('runStarted');
    expect(recorder.calls.at(-1)).toBe('runFinished');
    expect(recorder.sessionsFinished).toHaveLength(SIZE);
  });

  it('shows the designed difference: treatment activates in fewer steps and skips verification', () => {
    const controlSteps = byVariant('control').map((s) => s.steps);
    const treatmentSteps = byVariant('treatment').map((s) => s.steps);
    expect(Math.max(...treatmentSteps)).toBeLessThan(Math.min(...controlSteps));

    const urls = (variant: string): string[] =>
      byVariant(variant).flatMap((s) => stepsOf(s).map((step) => step.observation.url));
    expect(urls('control').some((u) => u.includes('/onboarding/verify'))).toBe(true);
    expect(urls('control').some((u) => u.includes('/onboarding/connect-bank'))).toBe(true);
    expect(urls('treatment').some((u) => u.includes('/onboarding/'))).toBe(true);
    expect(urls('treatment').some((u) => u.includes('/onboarding/verify'))).toBe(false);
    expect(urls('treatment').some((u) => u.includes('/onboarding/connect-bank'))).toBe(false);
  });

  it('computes session metrics from the intercepted events', () => {
    for (const session of outcome.sessions) {
      expect(session.metrics[SCENARIO_SUCCESS_METRIC_ID]).toBe(1);
      expect(session.metrics['activation']).toBe(1);
      expect(session.metrics['steps']).toBe(session.steps);
      expect(session.costUsd).toBeCloseTo(session.steps * 0.001);
    }
    expect(outcome.run.costUsd).toBeGreaterThan(0);
  });

  it("intercepts the app's own PostHog events and stamps every simulation marker on them", () => {
    expect(recorder.recordedEvents.length).toBeGreaterThan(0);
    for (const event of recorder.recordedEvents) {
      const parsed = AgonEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(event)).toBe(true);
      expect(event.runId).toBe(RUN_ID);
      for (const key of SIM_PROPERTY_KEYS) expect(event.properties, key).toHaveProperty(key);
    }

    for (const session of outcome.sessions) {
      for (const name of ['signup_completed', 'project_created']) {
        const matches = eventsOf(session, name);
        expect(matches, `${session.id} ${name}`).toHaveLength(1);
        const event = matches[0] as AgonEvent;
        expect(event.source).toBe('intercepted');
        expect(event.provider).toBe('posthog');
        expect(event.distinctId).toBe(session.persona.distinctId);
        expect(SimPropertiesSchema.parse(event.properties)).toEqual({
          agon_simulated: true,
          agon_run_id: RUN_ID,
          agon_session_id: session.id,
          agon_variant: session.variant,
          agon_persona: session.persona.personaId,
          agon_model: MODEL,
          agon_scenario: 'first-project',
        });
        // Properties the app itself attached survive the stamping.
        expect(event.properties['variant']).toBe(session.variant);
        expect(String(event.properties['distinct_id'])).toMatch(/^usr_/);
        expect(event.properties['$lib']).toBe('posthog-js');
      }
      expect(eventsOf(session, 'project_created')[0]?.properties).toMatchObject({
        source: 'onboarding',
        currency: 'USD',
      });
      expect(eventsOf(session, 'signup_started').length).toBeGreaterThan(0);
      expect(eventsOf(session, '$identify')).toHaveLength(1);
    }

    for (const session of byVariant('control')) {
      expect(eventsOf(session, 'onboarding_skipped')).toHaveLength(1);
      expect(eventsOf(session, 'onboarding_step_completed')).toHaveLength(4);
    }
    for (const session of byVariant('treatment')) {
      expect(eventsOf(session, 'onboarding_skipped')).toHaveLength(0);
      expect(eventsOf(session, 'onboarding_step_completed')).toHaveLength(1);
    }
  });

  it('infers pageviews, clicks and the session lifecycle alongside the intercepted events', () => {
    for (const session of outcome.sessions) {
      const inferred = eventsOf(session).filter((e) => e.source === 'inferred');
      const pageviews = inferred.filter((e) => e.event === INFERRED_EVENTS.pageview);
      expect(pageviews.length).toBeGreaterThanOrEqual(3);
      expect(pageviews[0]?.properties['$current_url']).toBe(`${variantUrl(session.variant)}/`);
      expect(pageviews.every((e) => e.provider === undefined)).toBe(true);
      expect(inferred.filter((e) => e.event === INFERRED_EVENTS.click).length).toBeGreaterThan(0);
      expect(inferred.filter((e) => e.event === INFERRED_EVENTS.sessionStart)).toHaveLength(1);
      expect(inferred.filter((e) => e.event === INFERRED_EVENTS.success)).toHaveLength(1);
      expect(inferred.filter((e) => e.event === INFERRED_EVENTS.sessionEnd)).toHaveLength(1);
      expect(inferred.filter((e) => e.event === INFERRED_EVENTS.error)).toHaveLength(0);
    }
    const pageviewCount = (variant: string): number =>
      byVariant(variant).reduce(
        (n, s) =>
          n + eventsOf(s, INFERRED_EVENTS.pageview).filter((e) => e.source === 'inferred').length,
        0,
      );
    expect(pageviewCount('control')).toBeGreaterThan(pageviewCount('treatment'));
  });

  it('never lets blocked analytics leave the browser', () => {
    expect(sink.requests).toEqual([]);
  });

  it('changed the real app: each variant registered its users and projects', async () => {
    for (const variant of ['control', 'treatment'] as const) {
      const app = variant === 'control' ? control : treatment;
      const created = await demoAppEvents(app, 'project_created');
      expect(created).toHaveLength(SIZE / 2);
      expect(created.every((e) => e.properties['variant'] === variant)).toBe(true);
      const skipped = await demoAppEvents(app, 'onboarding_skipped');
      expect(skipped).toHaveLength(variant === 'control' ? SIZE / 2 : 0);
    }
  });

  it('records a step for every decision, with a real observation and a successful action', () => {
    expect(recorder.steps).toHaveLength(outcome.sessions.reduce((n, s) => n + s.steps, 0));
    for (const session of outcome.sessions) {
      const steps = stepsOf(session);
      expect(steps.map((s) => s.index)).toEqual(steps.map((_, i) => i));
      for (const step of steps) {
        const { observation, result, decision } = step;
        expect(observation.url.startsWith(variantUrl(session.variant)), observation.url).toBe(true);
        expect(observation.text.length).toBeGreaterThan(0);
        expect(observation.title).toMatch(/Ledgerly/);
        expect(observation.interactive.length).toBeGreaterThan(0);
        expect(observation.interactive.every((e) => /^e\d+$/.test(e.ref))).toBe(true);
        expect(observation.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(observation.errors).toEqual([]);
        expect(result.ok, `${session.id} step ${step.index}: ${result.error ?? ''}`).toBe(true);
        expect(step.usage.model).toBe(MODEL);
        expect(step.patience).toBeGreaterThan(0.25);
        if ('ref' in decision.action) {
          expect(observation.interactive.map((e) => e.ref)).toContain(decision.action.ref);
        }
      }
      // Navigating clicks are reported as such; typing into a field is not.
      expect(steps.some((s) => s.decision.action.type === 'click' && s.result.navigated)).toBe(
        true,
      );
      expect(
        steps.filter((s) => s.decision.action.type === 'fill').every((s) => !s.result.navigated),
      ).toBe(true);
      // Nothing was skipped: the scripted user never had to scroll or give up.
      expect(steps.every((s) => s.decision.action.type !== 'scroll')).toBe(true);
      expect(steps.every((s) => s.decision.action.type !== 'give_up')).toBe(true);
    }
    expect(recorder.steps.every((s) => s.screenshot === undefined)).toBe(true);
    expect(llm.requests.every((r) => r.purpose === 'act' && r.model === MODEL)).toBe(true);
  });
});
