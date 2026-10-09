// This module is loaded by drizzle-kit as well as at runtime, so it imports nothing from
// `@agon/spec` except types: the enum value lists below are pinned to the spec unions at compile
// time (`satisfies` plus the exhaustiveness check at the bottom) and compared with the spec Zod
// enums in schema.test.ts.
import type {
  ActResult,
  AgonConfig,
  AnalysisMethod,
  AnalyticsProvider,
  CalibrationNote,
  Decision,
  DecisionStatus,
  DecisionTrace,
  EventSource,
  Judgement,
  LlmUsage,
  MetricResult,
  Observation,
  PersonaInstance,
  PolicyAction,
  Result,
  Run,
  RunStatus,
  RunTermination,
  SessionOutcome,
  SessionStatus,
  SquadScore,
  SquadStatus,
  TicketSource,
  VariantSpec,
} from '@agon/spec';
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[];
export const SESSION_STATUSES = [
  'pending',
  'running',
  'finished',
  'failed',
] as const satisfies readonly SessionStatus[];
export const SESSION_OUTCOMES = [
  'success',
  'gave_up',
  'max_steps',
  'budget_exceeded',
  'error',
  'stalled',
] as const satisfies readonly SessionOutcome[];
export const EVENT_SOURCES = [
  'intercepted',
  'inferred',
  'judge',
] as const satisfies readonly EventSource[];
export const ANALYTICS_PROVIDERS = [
  'posthog',
  'segment',
  'amplitude',
  'ga',
] as const satisfies readonly AnalyticsProvider[];
export const ANALYSIS_METHODS = [
  'bayesian',
  'sequential',
  'fixed',
] as const satisfies readonly AnalysisMethod[];
export const SQUAD_STATUSES = [
  'active',
  'paused',
  'killed',
] as const satisfies readonly SquadStatus[];
export const POLICY_ACTIONS = [
  'reallocate',
  'pause',
  'resume',
  'kill',
  'notify',
] as const satisfies readonly PolicyAction[];
export const DECISION_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'executed',
  'failed',
] as const satisfies readonly DecisionStatus[];
export const DECISION_ACTORS = ['auto', 'human'] as const satisfies readonly Decision['actor'][];
/** Roles an API key can carry; the spec has no enum for these yet. */
export const API_KEY_ROLES = ['observer', 'operator', 'squad'] as const;

export const runStatus = pgEnum('run_status', RUN_STATUSES);
export const sessionStatus = pgEnum('session_status', SESSION_STATUSES);
export const sessionOutcome = pgEnum('session_outcome', SESSION_OUTCOMES);
export const eventSource = pgEnum('event_source', EVENT_SOURCES);
export const analyticsProvider = pgEnum('analytics_provider', ANALYTICS_PROVIDERS);
export const analysisMethod = pgEnum('analysis_method', ANALYSIS_METHODS);
export const squadStatus = pgEnum('squad_status', SQUAD_STATUSES);
export const policyAction = pgEnum('policy_action', POLICY_ACTIONS);
export const decisionStatus = pgEnum('decision_status', DECISION_STATUSES);
export const decisionActor = pgEnum('decision_actor', DECISION_ACTORS);
export const apiKeyRole = pgEnum('api_key_role', API_KEY_ROLES);

/** Every timestamp is `timestamptz`, read as a `Date` and exposed as an ISO string by the repos. */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A stored `agon.yaml`. */
export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    config: jsonb('config').$type<AgonConfig>().notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    index('environments_name_idx').on(t.name),
    index('environments_created_at_idx').on(t.createdAt),
  ],
);

/** A dev-agent team, governed through decisions. */
export const squads = pgTable('squads', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique('squads_slug_key'),
  name: text('name').notNull(),
  status: squadStatus('status').notNull().default('active'),
  controlUrl: text('control_url'),
  ticketSource: jsonb('ticket_source').$type<TicketSource>(),
  allocation: doublePrecision('allocation').notNull().default(0),
  score: jsonb('score').$type<SquadScore>().notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedAt: timestamptz('updated_at').notNull(),
});

/** A concrete deployment of an environment's target, optionally credited to a squad. */
export const variants = pgTable(
  'variants',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    spec: jsonb('spec').$type<VariantSpec>().notNull(),
    squadId: text('squad_id').references(() => squads.id, { onDelete: 'set null' }),
    gitRef: text('git_ref'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    unique('variants_environment_id_name_key').on(t.environmentId, t.name),
    index('variants_squad_id_idx').on(t.squadId),
  ],
);

/** One execution of an environment; two or more variants make it an experiment. */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    status: runStatus('status').notNull(),
    variants: text('variants').array().notNull(),
    seed: bigint('seed', { mode: 'number' }).notNull(),
    config: jsonb('config').$type<AgonConfig>().notNull(),
    counts: jsonb('counts').$type<Run['counts']>().notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    resultId: text('result_id'),
    termination: jsonb('termination').$type<RunTermination>(),
    createdAt: timestamptz('created_at').notNull(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    error: text('error'),
  },
  (t) => [
    index('runs_environment_id_created_at_idx').on(t.environmentId, t.createdAt),
    index('runs_status_idx').on(t.status),
  ],
);

/** One simulated user's journey through one variant. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    variant: text('variant').notNull(),
    scenarioId: text('scenario_id').notNull(),
    persona: jsonb('persona').$type<PersonaInstance>().notNull(),
    status: sessionStatus('status').notNull(),
    outcome: sessionOutcome('outcome'),
    outcomeReason: text('outcome_reason'),
    steps: integer('steps').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    metrics: jsonb('metrics').$type<Record<string, number>>().notNull().default({}),
    judgement: jsonb('judgement').$type<Judgement>(),
    maxStepsSinceProgress: integer('max_steps_since_progress'),
    lastProgressStep: integer('last_progress_step'),
    progressSteps: jsonb('progress_steps').$type<number[]>(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    error: text('error'),
  },
  (t) => [
    index('sessions_run_id_idx').on(t.runId),
    unique('sessions_run_id_index_key').on(t.runId, t.index),
    index('sessions_run_id_variant_idx').on(t.runId, t.variant),
  ],
);

/** One perceive-decide-act cycle. Screenshots live in object storage, referenced from the observation. */
export const steps = pgTable(
  'steps',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    observation: jsonb('observation').$type<Observation>().notNull(),
    decision: jsonb('decision').$type<DecisionTrace>().notNull(),
    result: jsonb('result').$type<ActResult>().notNull(),
    patience: doublePrecision('patience').notNull(),
    usage: jsonb('usage').$type<LlmUsage>().notNull(),
    startedAt: timestamptz('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [unique('steps_session_id_index_key').on(t.sessionId, t.index)],
);

/** Analytics-style events, intercepted from the target or inferred by the engine. */
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    timestamp: timestamptz('timestamp').notNull(),
    event: text('event').notNull(),
    distinctId: text('distinct_id').notNull(),
    source: eventSource('source').notNull(),
    provider: analyticsProvider('provider'),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('events_run_id_timestamp_idx').on(t.runId, t.timestamp),
    index('events_session_id_timestamp_idx').on(t.sessionId, t.timestamp),
  ],
);

/** The analysis of one run. */
export const results = pgTable('results', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' })
    .unique('results_run_id_key'),
  method: analysisMethod('method').notNull(),
  control: text('control').notNull(),
  primaryMetricId: text('primary_metric_id').notNull(),
  metrics: jsonb('metrics').$type<MetricResult[]>().notNull(),
  decision: jsonb('decision').$type<Result['decision']>().notNull(),
  calibration: jsonb('calibration').$type<CalibrationNote>().notNull(),
  sessionsAnalyzed: integer('sessions_analyzed').notNull(),
  computedAt: timestamptz('computed_at').notNull(),
  engine: jsonb('engine').$type<Result['engine']>().notNull(),
});

/**
 * Append-only governance log. `squad_id` is deliberately not a foreign key: a decision must keep
 * naming the squad it concerned even if the squad is later removed.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    kind: policyAction('kind').notNull(),
    status: decisionStatus('status').notNull(),
    squadId: text('squad_id'),
    policyId: text('policy_id'),
    actor: decisionActor('actor').notNull(),
    rationale: text('rationale').notNull(),
    evidence: jsonb('evidence').$type<Decision['evidence']>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamptz('created_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    executedAt: timestamptz('executed_at'),
    error: text('error'),
  },
  (t) => [
    index('decisions_squad_id_created_at_idx').on(t.squadId, t.createdAt),
    index('decisions_created_at_idx').on(t.createdAt),
    index('decisions_status_idx').on(t.status),
  ],
);

/** API keys; only the SHA-256 hash of the secret is stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    keyHash: text('key_hash').notNull().unique('api_keys_key_hash_key'),
    role: apiKeyRole('role').notNull(),
    squadId: text('squad_id').references(() => squads.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [index('api_keys_squad_id_idx').on(t.squadId)],
);

/** `true` when `Values` lists every member of `Union`; otherwise names what is missing. */
type Exhaustive<Values extends readonly string[], Union extends string> = [
  Exclude<Union, Values[number]>,
] extends [never]
  ? true
  : ['missing enum values', Exclude<Union, Values[number]>];

// Compile-time proof that the lists above cover every value of the spec enums they mirror.
const enumsAreExhaustive: [
  Exhaustive<typeof RUN_STATUSES, RunStatus>,
  Exhaustive<typeof SESSION_STATUSES, SessionStatus>,
  Exhaustive<typeof SESSION_OUTCOMES, SessionOutcome>,
  Exhaustive<typeof EVENT_SOURCES, EventSource>,
  Exhaustive<typeof ANALYTICS_PROVIDERS, AnalyticsProvider>,
  Exhaustive<typeof ANALYSIS_METHODS, AnalysisMethod>,
  Exhaustive<typeof SQUAD_STATUSES, SquadStatus>,
  Exhaustive<typeof POLICY_ACTIONS, PolicyAction>,
  Exhaustive<typeof DECISION_STATUSES, DecisionStatus>,
  Exhaustive<typeof DECISION_ACTORS, Decision['actor']>,
] = [true, true, true, true, true, true, true, true, true, true];
void enumsAreExhaustive;

export type EnvironmentRow = typeof environments.$inferSelect;
export type SquadRow = typeof squads.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type StepRow = typeof steps.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ResultRow = typeof results.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
