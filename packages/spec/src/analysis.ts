import { z } from 'zod';
import { SlugSchema, UnitSchema } from './common.js';

export const AnalysisMethodSchema = z.enum(['bayesian', 'sequential', 'fixed']);
export type AnalysisMethod = z.infer<typeof AnalysisMethodSchema>;

export const AnalysisSchema = z.object({
  method: AnalysisMethodSchema.default('bayesian'),
  control: SlugSchema.optional().describe('Variant treated as baseline; defaults to "control" or the first variant'),
  minSessionsPerVariant: z.number().int().positive().default(30),
  decision: z
    .object({
      shipIf: UnitSchema.default(0.95).describe('P(best) at or above which the variant is a ship candidate'),
      killIf: UnitSchema.default(0.05).describe('P(best) at or below which the variant is a kill candidate'),
    })
    .prefault({}),
  alpha: z.number().gt(0).lt(1).default(0.05),
  clusterBy: z
    .array(z.enum(['persona', 'model', 'scenario']))
    .default(['persona', 'model'])
    .describe('Grouping factors treated as clusters when estimating uncertainty'),
  calibrationProfile: z.string().min(1).default('uncalibrated-v0'),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export type AnalysisInput = z.input<typeof AnalysisSchema>;
