import { z } from 'zod';
import { IdSchema, SlugSchema, TimestampSchema, UnitSchema } from './common.js';
import { AnalysisKindSchema, AnalysisMethodSchema } from './analysis.js';

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
  zStat: z
    .number()
    .optional()
    .describe('Test statistic of variant minus control (fixed and sequential methods)'),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

export const VarianceDecompositionSchema = z.object({
  persona: UnitSchema,
  model: UnitSchema,
  scenario: UnitSchema.optional(),
  residual: UnitSchema,
});

export const StratumVariantSchema = z.object({
  variant: SlugSchema,
  sessions: z.number().int().nonnegative(),
  mean: z.number(),
});
export type StratumVariant = z.infer<typeof StratumVariantSchema>;

export const StratumComparisonSchema = z.object({
  variant: SlugSchema,
  control: SlugSchema,
  difference: z.number().describe('Variant mean minus control mean within the stratum'),
  differenceCi95: z.tuple([z.number(), z.number()]),
  lift: z.number().describe('Relative lift of variant over control within the stratum'),
  liftCi95: z.tuple([z.number(), z.number()]),
});
export type StratumComparison = z.infer<typeof StratumComparisonSchema>;

export const StratumSchema = z.object({
  levels: z
    .record(z.string(), z.string())
    .describe('The factor levels that define the stratum, e.g. { persona: "smb-owner" }'),
  sessions: z.number().int().nonnegative(),
  variants: z.array(StratumVariantSchema),
  comparisons: z
    .array(StratumComparisonSchema)
    .describe('One per treatment with at least two sessions in both arms of the stratum'),
});
export type Stratum = z.infer<typeof StratumSchema>;

export const HeterogeneitySchema = z.object({
  variant: SlugSchema,
  control: SlugSchema,
  strata: z.number().int().nonnegative().describe('Strata with an estimable difference'),
  pooledDifference: z
    .number()
    .describe('Inverse-variance weighted difference across those strata (fixed effect)'),
  pooledDifferenceCi95: z.tuple([z.number(), z.number()]),
  q: z.number().nonnegative().describe("Cochran's Q"),
  df: z.number().int().nonnegative(),
  pValue: UnitSchema,
  iSquared: UnitSchema.describe('Share of the variation across strata beyond sampling noise'),
});
export type Heterogeneity = z.infer<typeof HeterogeneitySchema>;

/** The per-stratum report `analysis.stratifyBy` asks for. A pooled number never travels without its heterogeneity statistic. */
export const StratificationSchema = z.object({
  by: z.array(z.enum(['persona', 'model', 'scenario'])),
  strata: z.array(StratumSchema),
  heterogeneity: z
    .array(HeterogeneitySchema)
    .describe('One per treatment with at least two estimable strata'),
});
export type Stratification = z.infer<typeof StratificationSchema>;

export const MetricResultSchema = z.object({
  metricId: SlugSchema,
  direction: z.enum(['increase', 'decrease']),
  variants: z.array(VariantStatsSchema),
  comparisons: z.array(ComparisonSchema),
  varianceDecomposition: VarianceDecompositionSchema.optional(),
  stratification: StratificationSchema.optional(),
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
  kind: AnalysisKindSchema.default('model').describe(
    'model: computed before release from simulated sessions (a rehearsal); measurement: the live window after release (an observation). Results of agon-stats analyze are always models',
  ),
  assumptions: z
    .array(z.string())
    .default([])
    .describe('What a model result assumes; empty for a measurement'),
  requirementsDigest: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Hash of the requirements this receipt was accepted under: the analysis section (materiality included), the metrics and the policies. Absent only on results computed before receipts existed; never rewritten',
    ),
});
export type Result = z.infer<typeof ResultSchema>;
