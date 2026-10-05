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
});

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
  dryRun: z.boolean().default(false).describe('Plan sessions without executing them'),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRequestInput = z.input<typeof RunRequestSchema>;

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
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;
