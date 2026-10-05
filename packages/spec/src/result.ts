import { z } from 'zod';
import { IdSchema, SlugSchema, TimestampSchema, UnitSchema } from './common.js';
import { AnalysisMethodSchema } from './analysis.js';

export const VariantStatsSchema = z.object({
  variant: SlugSchema,
  sessions: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative().optional().describe('Binary metrics only'),
  mean: z.number(),
  stderr: z.number().nonnegative(),
  ci95: z.tuple([z.number(), z.number()]),
  effectiveSampleSize: z.number().nonnegative().optional(),
});
export type VariantStats = z.infer<typeof VariantStatsSchema>;

export const ComparisonSchema = z.object({
  variant: SlugSchema,
  control: SlugSchema,
  lift: z.number().describe('Relative lift of variant over control'),
  liftCi95: z.tuple([z.number(), z.number()]),
  pBest: UnitSchema.describe('Posterior probability this variant is the best of all variants'),
  pBeatControl: UnitSchema,
  expectedLoss: z.number().nonnegative(),
  pValue: UnitSchema.optional(),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

export const VarianceDecompositionSchema = z.object({
  persona: UnitSchema,
  model: UnitSchema,
  scenario: UnitSchema.optional(),
  residual: UnitSchema,
});

export const MetricResultSchema = z.object({
  metricId: SlugSchema,
  direction: z.enum(['increase', 'decrease']),
  variants: z.array(VariantStatsSchema),
  comparisons: z.array(ComparisonSchema),
  varianceDecomposition: VarianceDecompositionSchema.optional(),
  warnings: z.array(z.string()).default([]),
});
export type MetricResult = z.infer<typeof MetricResultSchema>;

export const VerdictSchema = z.enum(['ship', 'kill', 'continue', 'inconclusive']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Every result carries its calibration provenance; UIs show `note` next to any lift or p-value. */
export const CalibrationNoteSchema = z.object({
  profile: z.string().min(1),
  changeCategory: z.string().optional(),
  directionAccuracy: UnitSchema.optional().describe(
    'Benchmark agreement rate for this change category',
  ),
  note: z.string().min(1),
});
export type CalibrationNote = z.infer<typeof CalibrationNoteSchema>;

export const ResultSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  method: AnalysisMethodSchema,
  control: SlugSchema,
  primaryMetricId: SlugSchema,
  metrics: z.array(MetricResultSchema),
  decision: z.object({
    verdict: VerdictSchema,
    variant: SlugSchema.optional(),
    rationale: z.string(),
  }),
  calibration: CalibrationNoteSchema,
  sessionsAnalyzed: z.number().int().nonnegative(),
  computedAt: TimestampSchema,
  engine: z.object({ name: z.string(), version: z.string() }),
});
export type Result = z.infer<typeof ResultSchema>;
