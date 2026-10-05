import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SessionSchema, StepSchema, AgonEventSchema, type DecisionTrace } from '@agon/spec';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { resolvePersonas } from '../population/personas.js';
import { planSessions } from '../population/sampler.js';
import { testConfig } from '../fakes/config.js';
import {
  FakeAdapter,
  FakeLlm,
  MemoryRecorder,
  happyUser,
  ledgerlySite,
  type UserPolicy,
} from '../fakes/fakes.js';
import { computeSessionMetrics } from './metrics.js';
import { runSession } from './runner.js';
import { criterionMet, urlMatches } from './success.js';

const logger = pino({ level: 'silent' });

function setup(
  policy: UserPolicy,
  configOverrides: Parameters<typeof testConfig>[0] = {},
  llmOptions = {},
) {
  const config = testConfig(configOverrides);
  const personas = resolvePersonas(config);
  const [plan] = planSessions(config, personas, {
    runId: 'run_t1',
    variants: ['control'],
    seed: 1,
    size: 1,
    defaultModel: config.defaults.model,
  });
  const adapter = new FakeAdapter(ledgerlySite);
  const llm = new FakeLlm(policy, llmOptions);
  const recorder = new MemoryRecorder();
  const run = () =>
    runSession(
      { runId: 'run_t1', config, plan: plan!, variantSpec: config.target.variants['control']! },
      { llm, adapter, recorder, logger, cwd: process.cwd() },
    );
  return { config, plan: plan!, adapter, llm, recorder, run };
}

describe('runSession', () => {
  it('drives a happy user to success, records steps and events, computes metrics', async () => {
    const { run, recorder, adapter, llm } = setup(happyUser);
    const { session, steps, events } = await run();

    expect(session.outcome).toBe('success');
    expect(session.status).toBe('finished');
    expect(steps.map((s) => s.decision.action.type)).toEqual([
      'click',
      'fill',
      'fill',
      'click',
      'fill',
      'click',
    ]);
    expect(session.steps).toBe(6);
    expect(session.costUsd).toBeCloseTo(0.006);
    expect(session.metrics).toMatchObject({
      scenario_success: 1,
      activation: 1,
      steps: 6,
      clicks: 3,
    });
    expect(session.metrics['time_to_activate']).toBeGreaterThanOrEqual(0);

    const names = events.map((e) => e.event);
    expect(names).toContain('$agon_session_start');
    expect(names).toContain('signup_completed');
    expect(names).toContain('project_created');
    expect(names).toContain('$agon_success');
    expect(names.at(-1)).toBe('$agon_session_end');
    for (const e of events) {
      expect(AgonEventSchema.safeParse(e).success).toBe(true);
      expect(e.properties).toMatchObject({
        agon_simulated: true,
        agon_run_id: 'run_t1',
        agon_variant: 'control',
        agon_persona: 'eager',
      });
      expect(e.distinctId).toBe(session.persona.distinctId);
    }
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);

    expect(SessionSchema.safeParse(session).success).toBe(true);
    for (const s of steps) expect(StepSchema.safeParse(s).success).toBe(true);
    expect(recorder.calls[0]).toBe('sessionStarted');
    expect(recorder.calls.at(-1)).toBe('sessionFinished');
    expect(recorder.steps).toHaveLength(6);
    expect(recorder.recordedEvents.length).toBe(events.length);
    expect(adapter.sessions[0]?.closed).toBe(true);
    // no judge needed: no score metric and an event criterion
    expect(llm.requests.every((r) => r.purpose === 'act')).toBe(true);
    expect(llm.requests[0]?.cacheKey).toBeDefined();
  });

  it('stops when the user gives up and emits an abandon event', async () => {
    const quitter: UserPolicy = (p) =>
      p.path === '/'
        ? happyUser(p, undefined as never)
        : {
            perception: 'A form.',
            thinking: 'Not worth it.',
            feeling: 'frustrated',
            progress: 'none',
            action: { type: 'give_up', reason: 'Too much hassle for a trial.' },
          };
    const { run } = setup(quitter);
    const { session, events } = await run();
    expect(session.outcome).toBe('gave_up');
    expect(session.outcomeReason).toBe('Too much hassle for a trial.');
    expect(session.steps).toBe(2);
    expect(events.find((e) => e.event === '$agon_abandon')?.properties).toMatchObject({
      reason: 'Too much hassle for a trial.',
    });
    expect(session.metrics).toMatchObject({ scenario_success: 0, activation: 0 });
  });

  it('abandons deterministically when patience runs out', async () => {
    const dithering: UserPolicy = () => ({
      perception: 'Nothing changes.',
      thinking: 'Hm.',
      feeling: 'frustrated',
      progress: 'none',
      action: { type: 'scroll', direction: 'down' },
    });
    const { run } = setup(dithering, {
      population: { seed: 1, size: 1, personas: [{ use: 'impatient' }], traitJitter: 0 },
    });
    const first = await run();
    expect(first.session.outcome).toBe('gave_up');
    expect(first.session.outcomeReason).toBe('patience exhausted');
    expect(first.session.steps).toBeLessThan(6);
    const second = await setup(dithering, {
      population: { seed: 1, size: 1, personas: [{ use: 'impatient' }], traitJitter: 0 },
    }).run();
    expect(second.session.steps).toBe(first.session.steps);
  });

  it('hits the step limit for a user who keeps busy without finishing', async () => {
    const browser: UserPolicy = () => ({
      perception: 'Interesting.',
      thinking: 'Keep looking.',
      feeling: 'confident',
      progress: 'progress',
      action: { type: 'scroll', direction: 'down' },
    });
    const { run } = setup(browser, {
      scenarios: [{ id: 's', goal: 'Look around.', success: 'event:project_created', maxSteps: 3 }],
    });
    const { session } = await run();
    expect(session.outcome).toBe('max_steps');
    expect(session.steps).toBe(3);
  });

  it('enforces the per-scenario budget', async () => {
    const { run } = setup(
      happyUser,
      {
        scenarios: [
          { id: 's', goal: 'Sign up.', success: 'event:project_created', budgetUsd: 0.25 },
        ],
      },
      { costPerCall: 0.1 },
    );
    const { session } = await run();
    expect(session.outcome).toBe('budget_exceeded');
    expect(session.steps).toBe(3);
    expect(session.outcomeReason).toMatch(/budget/);
  });

  it('treats "done" as unverified when the success criterion is not met, and verifies it when it is', async () => {
    const premature: UserPolicy = (p) =>
      p.path === '/'
        ? {
            perception: 'Looks fine.',
            thinking: 'Good enough.',
            feeling: 'confident',
            progress: 'progress',
            action: { type: 'done', reason: 'I have seen it.' },
          }
        : happyUser(p, undefined as never);
    const { run } = setup(premature);
    const { session } = await run();
    expect(session.outcome).toBe('gave_up');
    expect(session.outcomeReason).toMatch(/declared done without reaching/);

    const urlCfg = {
      scenarios: [{ id: 's', goal: 'Reach the app.', success: 'url:**/app', maxSteps: 12 }],
    };
    const verified = await setup(happyUser, urlCfg).run();
    expect(verified.session.outcome).toBe('success');
  });

  it('uses the judge for judge criteria and score metrics', async () => {
    const { run, llm } = setup(happyUser, {
      scenarios: [{ id: 's', goal: 'Create a project.', success: 'judge', maxSteps: 12 }],
      metrics: [
        { id: 'frustration', type: 'score', source: 'judge', score: 'frustration' },
        { id: 'satisfaction', type: 'score' },
      ],
    });
    const { session } = await run();
    expect(session.outcome).toBe('success');
    expect(session.outcomeReason).toMatch(/^judge:/);
    expect(session.judgement).toMatchObject({ success: true, satisfaction: 4, frustration: 1 });
    expect(session.metrics).toMatchObject({ frustration: 1, satisfaction: 4, scenario_success: 1 });
    expect(llm.requests.filter((r) => r.purpose === 'judge')).toHaveLength(1);
    expect(session.costUsd).toBeCloseTo(0.007); // 6 act calls + 1 judge call
  });

  it('runs setup hooks and hands credentials to the user prompt', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agon-hook-`);
    const { run, llm } = setup(happyUser, {
      target: {
        kind: 'web',
        variants: { control: { url: 'http://control.test' } },
        session: {
          setup: `node -e 'console.log(JSON.stringify({ email: "hook@example.com", password: "pw", session: process.env.AGON_SESSION_ID }))'`,
        },
      },
    });
    void dir;
    const { session } = await run();
    expect(session.outcome).toBe('success');
    expect(llm.requests[0]?.system).toContain('email = hook@example.com');
    expect(llm.requests[0]?.system).toContain('session = ses_t1_00000');
  });

  it('marks the session failed when the adapter cannot open, and still finishes cleanly', async () => {
    const config = testConfig();
    const [plan] = planSessions(config, resolvePersonas(config), {
      runId: 'run_t2',
      variants: ['control'],
      seed: 1,
      size: 1,
      defaultModel: 'fake/m',
    });
    const recorder = new MemoryRecorder();
    const { session, steps } = await runSession(
      { runId: 'run_t2', config, plan: plan!, variantSpec: config.target.variants['control']! },
      {
        llm: new FakeLlm(happyUser),
        adapter: new FakeAdapter(ledgerlySite, { failOnOpen: true }),
        recorder,
        logger,
        cwd: process.cwd(),
      },
    );
    expect(session.status).toBe('failed');
    expect(session.outcome).toBe('error');
    expect(session.error).toMatch(/browser failed to launch/);
    expect(steps).toHaveLength(0);
    expect(recorder.sessionsFinished).toHaveLength(1);
  });

  it('rejects actions on refs that are not on the page without crashing', async () => {
    let calls = 0;
    const clumsy: UserPolicy = (p) => {
      calls++;
      if (calls === 1)
        return {
          perception: 'x',
          thinking: 'y',
          feeling: 'neutral',
          progress: 'none',
          action: { type: 'click', ref: 'e999' },
        } satisfies DecisionTrace;
      return happyUser(p, undefined as never);
    };
    const { run } = setup(clumsy);
    const { session, steps } = await run();
    expect(steps[0]?.result).toEqual({
      ok: false,
      error: 'there is no e999 on this page',
      navigated: false,
    });
    expect(session.outcome).toBe('success');
  });
});

describe('fakes', () => {
  it('parsePrompt reads refs, names, empty markers and filled values', async () => {
    const { parsePrompt } = await import('../fakes/fakes.js');
    const parsed = parsePrompt(
      'URL: http://x.test/signup\n[e1] textbox "Email" (value: "a@b.c")\n[e2] textbox "Password" (empty)\n[e3] button "Go"',
    );
    expect(parsed.path).toBe('/signup');
    expect(parsed.refs.get('e1')).toEqual({ role: 'textbox', name: 'Email', value: 'a@b.c' });
    expect(parsed.refs.get('e2')).toEqual({ role: 'textbox', name: 'Password', value: '' });
    expect(parsed.refs.get('e3')).toEqual({ role: 'button', name: 'Go' });
  });

  it('a user stuck on a failing action gives up well before the step limit', async () => {
    let n = 0;
    const stuck: UserPolicy = () => ({
      perception: 'A button.',
      thinking: 'Try again.',
      feeling: 'confused',
      progress: 'none',
      action: { type: 'click', ref: `e${++n > 0 ? 999 : 1}` },
    });
    const { run } = setup(stuck, {
      scenarios: [{ id: 's', goal: 'g', success: 'event:project_created', maxSteps: 40 }],
    });
    const { session } = await run();
    expect(session.outcome).toBe('gave_up');
    expect(session.steps).toBeLessThan(10);
  });
});

describe('success criteria and metrics', () => {
  it('matches urls by substring and glob', () => {
    expect(urlMatches('http://x.test/app?x=1', '/app')).toBe(true);
    expect(urlMatches('http://x.test/app/settings', '**/app/*')).toBe(true);
    expect(urlMatches('http://x.test/other', '**/app')).toBe(false);
    expect(
      criterionMet(
        { type: 'text', contains: 'welcome' },
        {
          url: 'u',
          title: '',
          text: 'Welcome aboard',
          interactive: [],
          errors: [],
          truncated: false,
          hash: 'h',
          capturedAt: '2026-01-01T00:00:00Z',
        },
        [],
      ),
    ).toBe(true);
    expect(criterionMet({ type: 'judge' }, undefined, [])).toBe(false);
  });

  it('computes durations from timestamps and scores from the judge', () => {
    const config = testConfig({
      metrics: [
        { id: 'ttfp', type: 'duration', from: 'session_start', to: 'project_created' },
        { id: 'sat', type: 'score' },
      ],
    });
    const metrics = computeSessionMetrics(
      config,
      {
        outcome: 'success',
        steps: 4,
        startedAt: '2026-01-01T00:00:00.000Z',
        judgement: { success: true, satisfaction: 5, frustration: 2, confidence: 1, summary: '' },
      },
      [
        {
          id: 'e',
          runId: 'r',
          sessionId: 's',
          timestamp: '2026-01-01T00:00:12.500Z',
          event: 'project_created',
          distinctId: 'd',
          source: 'intercepted',
          properties: {},
        },
      ],
    );
    expect(metrics).toEqual({ scenario_success: 1, ttfp: 12.5, sat: 5 });
  });
});
