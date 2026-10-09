import { z } from 'zod';
import { AgonConfigSchema } from './config.js';
import { IdSchema, ModelRefSchema, SlugSchema, TimestampSchema } from './common.js';

/** A stored `agon.yaml`: what to simulate. Runs are created from it. */
export const EnvironmentSchema = z.object({
  id: IdSchema,
  name: SlugSchema,
  config: AgonConfigSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const RunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunCountsSchema = z.object({
  planned: z.number().int().nonnegative().default(0),
  running: z.number().int().nonnegative().default(0),
  completed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  interrupted: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Sessions the run stopped before they reached an outcome (time cap)'),
});
export type RunCounts = z.infer<typeof RunCountsSchema>;

/** Parameters a caller may override when starting a run. */
export const RunRequestSchema = z.object({
  variants: z
    .array(SlugSchema)
    .min(1)
    .optional()
    .describe('Subset of variants to run; default all'),
  seed: z.number().int().nonnegative().optional(),
  size: z.number().int().positive().optional().describe('Override population.size'),
  model: ModelRefSchema.optional().describe('Override defaults.model'),
  timeCapMs: z.number().int().positive().optional().describe('Override defaults.timeCapMs'),
  dryRun: z.boolean().default(false).describe('Plan sessions without executing them'),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRequestInput = z.input<typeof RunRequestSchema>;

// ---------------------------------------------------------------------------
// Termination: how a run ended, typed so a time cap is a partial result, not a failure.
// ---------------------------------------------------------------------------

export const RunTerminationKindSchema = z.enum([
  'completed',
  'time_cap_reached',
  'failed',
  'infra_aborted',
  'cancelled',
]);
export type RunTerminationKind = z.infer<typeof RunTerminationKindSchema>;

export const RunStageSchema = z.enum(['setup', 'sessions', 'analysis', 'export']);
export type RunStage = z.infer<typeof RunStageSchema>;

export const RunFailureSchema = z.object({
  id: z.string().min(1).describe('Session id, or the run id when the run itself failed'),
  location: z.string().min(1).describe('Where it failed, e.g. "adapter open" or "step 3 act"'),
  message: z.string(),
});
export type RunFailure = z.infer<typeof RunFailureSchema>;

/** What a run that stopped early still produced. */
export const PartialDeltaManifestSchema = z.object({
  sessionsPerVariant: z
    .record(SlugSchema, z.number().int().nonnegative())
    .describe('Sessions that reached an outcome, per variant'),
  metricsComputed: z.array(z.string()).describe('Metric ids computed on those sessions'),
  exportsWritten: z.array(z.string()).describe('Sinks that received the run, as "<type>:<target>"'),
});
export type PartialDeltaManifest = z.infer<typeof PartialDeltaManifestSchema>;

export const RunTerminationSchema = z.object({
  kind: RunTerminationKindSchema.describe(
    'completed: every planned session ran (the verdict decides); time_cap_reached: defaults.timeCapMs elapsed, partial result; failed: every executed session failed; infra_aborted: the adapter, target or model provider was unreachable or errored, not the product; cancelled: stopped on request',
  ),
  elapsedMs: z.number().int().nonnegative().describe('Wall clock since the run started'),
  capMs: z.number().int().positive().describe('The time cap in force (defaults.timeCapMs)'),
  lastCompletedStage: RunStageSchema,
  sessionsExecuted: z
    .number()
    .int()
    .nonnegative()
    .describe('Sessions that reached an outcome, successful or failed'),
  sessionsPlanned: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative().default(0),
  partialDeltaManifest: PartialDeltaManifestSchema.optional().describe(
    'Present when the run stopped early (time cap, cancellation)',
  ),
  firstFailure: RunFailureSchema.optional().describe('Present when at least one session failed'),
});
export type RunTermination = z.infer<typeof RunTerminationSchema>;

/**
 * Process exit codes of `agon run` per termination kind, for CI check conclusions: 0 lets the
 * verdict decide, 1 is a red build, 3 maps to "neutral" (the cap stopped the run, nothing is
 * wrong with the product), 4 says the infrastructure failed, 5 that someone cancelled.
 */
export const TERMINATION_EXIT_CODES = {
  completed: 0,
  failed: 1,
  time_cap_reached: 3,
  infra_aborted: 4,
  cancelled: 5,
} as const satisfies Record<RunTerminationKind, number>;

export function terminationExitCode(kind: RunTerminationKind): number {
  return TERMINATION_EXIT_CODES[kind];
}

export const RunSchema = z.object({
  id: IdSchema,
  environmentId: IdSchema,
  status: RunStatusSchema,
  variants: z.array(SlugSchema).min(1),
  seed: z.number().int().nonnegative(),
  config: AgonConfigSchema.describe('Snapshot of the environment config at run time'),
  counts: RunCountsSchema.prefault({}),
  costUsd: z.number().nonnegative().default(0),
  resultId: IdSchema.optional(),
  termination: RunTerminationSchema.optional().describe('How the run ended; set once it finished'),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;
