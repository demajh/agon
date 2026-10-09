import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgonConfig,
  AgonEvent,
  PersonaInstance,
  Result,
  Run,
  Session,
  Step,
} from '@agon/spec';
import {
  AgonConfigSchema,
  AgonEventSchema,
  ResultSchema,
  RunSchema,
  SessionSchema,
  StepSchema,
  simProperties,
} from '@agon/spec';
import type { Exporter, ExporterContext } from '../exporter.js';

export const RUN_ID = 'run_fixture000000001';
export const EXPERIMENT_NAME = 'onboarding-redesign';
export const EXPERIMENT_KEY = 'onboarding-redesign';
export const MODEL = 'anthropic/claude-sonnet-5-5';

const T0 = Date.UTC(2026, 9, 4, 17, 0, 0);

export function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

export function makeContext(overrides: Partial<ExporterContext> = {}): ExporterContext {
  return { runId: RUN_ID, experimentName: EXPERIMENT_NAME, ...overrides };
}

/** Every fixture is parsed through its spec schema so tests only ever see valid objects. */
export function makeConfig(): AgonConfig {
  return AgonConfigSchema.parse({
    version: 1,
    name: EXPERIMENT_NAME,
    target: {
      kind: 'web',
      variants: {
        control: { url: 'https://control.example.com' },
        treatment: { url: 'https://treatment.example.com', squad: 'squad-blue' },
      },
    },
    population: { seed: 7, size: 4, personas: [{ use: 'builtin/smb-owner', weight: 1 }] },
    scenarios: [
      {
        id: 'first-project',
        goal: 'Sign up and create a first project',
        success: 'event:project_created',
      },
    ],
    metrics: [
      { id: 'activation', type: 'conversion', event: 'project_created', primary: true },
      { id: 'time_to_activate', type: 'duration', to: 'project_created' },
    ],
    export: [{ type: 'jsonl', path: './agon-out' }],
  });
}

export function makeRun(overrides: Partial<Run> = {}): Run {
  return RunSchema.parse({
    id: RUN_ID,
    environmentId: 'env_fixture',
    status: 'running',
    variants: ['control', 'treatment'],
    seed: 7,
    config: makeConfig(),
    counts: { planned: 4, running: 0, completed: 0, failed: 0 },
    costUsd: 0,
    createdAt: iso(0),
    startedAt: iso(1_000),
    ...overrides,
  });
}

export function makePersona(index: number): PersonaInstance {
  return {
    personaId: 'smb-owner',
    name: 'SMB owner',
    summary: 'You run a 12-person agency and want tools that pay for themselves quickly.',
    traits: {
      role: 'owner of a 12-person agency',
      techProficiency: 'intermediate',
      patience: 0.5,
      attention: 0.5,
      domainFamiliarity: 0.4,
      riskTolerance: 0.5,
      priceSensitivity: 0.7,
    },
    goals: ['get set up quickly'],
    frustrations: ['long forms'],
    device: index % 2 === 0 ? 'desktop' : 'mobile',
    locale: 'en-US',
    model: MODEL,
    seed: 100 + index,
    distinctId: `sim_${RUN_ID}_${String(index).padStart(5, '0')}`,
  };
}

export function isSuccessful(index: number): boolean {
  return index % 3 !== 2;
}

export function makeSession(index: number, overrides: Partial<Session> = {}): Session {
  const success = isSuccessful(index);
  const startedAt = iso(10_000 + index * 60_000);
  return SessionSchema.parse({
    id: `ses_fixture000000001_${String(index).padStart(5, '0')}`,
    runId: RUN_ID,
    index,
    variant: index % 2 === 0 ? 'control' : 'treatment',
    scenarioId: 'first-project',
    persona: makePersona(index),
    status: 'finished',
    outcome: success ? 'success' : 'gave_up',
    outcomeReason: success ? undefined : 'could not find pricing',
    steps: 5 + index,
    costUsd: 0.01 * (index + 1),
    inputTokens: 1_000 * (index + 1),
    outputTokens: 200 * (index + 1),
    metrics: { activation: success ? 1 : 0, time_to_activate: 30 + index },
    judgement: success
      ? {
          success: true,
          satisfaction: 4,
          frustration: 2,
          confidence: 0.8,
          summary: 'Found it quickly',
        }
      : undefined,
    startedAt,
    finishedAt: iso(10_000 + index * 60_000 + 45_000),
    ...overrides,
  });
}

export function makeStep(session: Session, index: number): Step {
  const at = iso(10_000 + session.index * 60_000 + index * 5_000);
  return StepSchema.parse({
    id: `stp_${session.index}_${index}`,
    sessionId: session.id,
    index,
    observation: {
      url: 'https://control.example.com/signup',
      title: 'Sign up',
      text: 'Create your account to get started.',
      interactive: [{ ref: 'e1', role: 'button', name: 'Continue' }],
      hash: `hash_${session.index}_${index}`,
      capturedAt: at,
    },
    decision: {
      perception: 'A short signup form',
      thinking: 'Fill in my email and continue',
      feeling: 'neutral',
      progress: 'progress',
      action: { type: 'click', ref: 'e1' },
    },
    result: { ok: true, navigated: true },
    patience: 0.8,
    usage: {
      model: session.persona.model,
      inputTokens: 500,
      outputTokens: 50,
      costUsd: 0.002,
      latencyMs: 800,
    },
    startedAt: at,
    durationMs: 1_200,
  });
}

export function sessionMarkers(session: Session): Record<string, unknown> {
  return simProperties({
    runId: session.runId,
    sessionId: session.id,
    variant: session.variant,
    personaId: session.persona.personaId,
    model: session.persona.model,
    scenarioId: session.scenarioId,
  });
}

export function makeEvent(
  session: Session,
  index: number,
  overrides: Partial<AgonEvent> = {},
): AgonEvent {
  const first = index === 0;
  return AgonEventSchema.parse({
    id: `evt_${session.index}_${index}`,
    runId: RUN_ID,
    sessionId: session.id,
    timestamp: iso(10_000 + session.index * 60_000 + index * 7_000),
    event: first ? '$agon_session_start' : 'project_created',
    distinctId: session.persona.distinctId,
    source: first ? 'inferred' : 'intercepted',
    provider: first ? undefined : 'posthog',
    properties: {
      ...sessionMarkers(session),
      plan: 'pro',
      $current_url: 'https://control.example.com/app',
    },
    ...overrides,
  });
}

/** Looks like real traffic: no simulation markers. Cannot be produced through the schema. */
export function makeUnmarkedEvent(session: Session): AgonEvent {
  return {
    id: 'evt_unmarked',
    runId: RUN_ID,
    sessionId: session.id,
    timestamp: iso(20_000),
    event: 'project_created',
    distinctId: session.persona.distinctId,
    source: 'intercepted',
    provider: 'posthog',
    properties: { plan: 'pro' },
  };
}

export function makeResult(): Result {
  return ResultSchema.parse({
    id: 'res_fixture',
    runId: RUN_ID,
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
            pBest: 0.8,
            pBeatControl: 0.8,
            expectedLoss: 0.02,
          },
        ],
      },
    ],
    decision: { verdict: 'continue', rationale: 'Too few sessions to decide' },
    calibration: {
      profile: 'uncalibrated-v0',
      note: 'Simulated results are a forecast; this profile has no benchmark agreement data yet.',
    },
    sessionsAnalyzed: 4,
    computedAt: iso(600_000),
    engine: { name: 'agon-stats', version: '0.0.1' },
    kind: 'model',
    assumptions: ['sessions were simulated by LLM-driven personas, not real users'],
    requirementsDigest: 'f'.repeat(64),
  });
}

export interface LifecycleOptions {
  sessions?: number;
  stepsPerSession?: number;
  eventsPerSession?: number;
  withResult?: boolean;
}

export interface LifecycleData {
  run: Run;
  finishedRun: Run;
  sessions: Session[];
  steps: Step[];
  events: AgonEvent[];
  result: Result | undefined;
}

/** Drives an exporter through a realistic run without closing it. */
export async function runLifecycle(
  exporter: Exporter,
  options: LifecycleOptions = {},
): Promise<LifecycleData> {
  const count = options.sessions ?? 4;
  const stepsPerSession = options.stepsPerSession ?? 2;
  const eventsPerSession = options.eventsPerSession ?? 2;
  const run = makeRun();
  const sessions: Session[] = [];
  const steps: Step[] = [];
  const events: AgonEvent[] = [];
  await exporter.runStarted(run);
  for (let i = 0; i < count; i++) {
    const session = makeSession(i);
    const sessionSteps = Array.from({ length: stepsPerSession }, (_, j) => makeStep(session, j));
    const sessionEvents = Array.from({ length: eventsPerSession }, (_, j) => makeEvent(session, j));
    await exporter.steps(sessionSteps);
    await exporter.events(sessionEvents);
    await exporter.sessionFinished(session);
    sessions.push(session);
    steps.push(...sessionSteps);
    events.push(...sessionEvents);
  }
  const result = options.withResult === false ? undefined : makeResult();
  const finishedRun = makeRun({
    status: 'completed',
    counts: { planned: count, running: 0, completed: count, failed: 0, interrupted: 0 },
    costUsd: sessions.reduce((sum, s) => sum + s.costUsd, 0),
    finishedAt: iso(900_000),
    ...(result ? { resultId: result.id } : {}),
  });
  await exporter.runFinished(finishedRun, result);
  return { run, finishedRun, sessions, steps, events, result };
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agon-exporters-'));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
