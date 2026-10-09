import { z } from 'zod';
import { SlugSchema, UnitSchema } from './common.js';

export const AnalysisMethodSchema = z.enum(['bayesian', 'sequential', 'fixed']);
export type AnalysisMethod = z.infer<typeof AnalysisMethodSchema>;

/**
 * Whether an analysis is a rehearsal or an observation: `model` for anything computed before a
 * release (simulated sessions, calibrated forecasts), `measurement` for the live window after it.
 */
export const AnalysisKindSchema = z.enum(['model', 'measurement']);
export type AnalysisKind = z.infer<typeof AnalysisKindSchema>;

/**
 * The materiality boundary: which fields of the outputs a decision may turn on. It is part of the
 * requirements digest, so moving a field across the boundary after an incident changes the
 * digest for future attempts while every past receipt keeps the boundary it was accepted under.
 */
export const MaterialitySchema = z.object({
  fields: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Dotted paths of output fields that count as decision-relevant (e.g. "outcome", "metrics.activation", "response.total")',
    ),
  note: z
    .string()
    .optional()
    .describe('Why the boundary sits where it does, e.g. the incident that moved a field in'),
});
export type Materiality = z.infer<typeof MaterialitySchema>;
export type MaterialityInput = z.input<typeof MaterialitySchema>;

export const AnalysisSchema = z.object({
  method: AnalysisMethodSchema.default('bayesian'),
  control: SlugSchema.optional().describe(
    'Variant treated as baseline; defaults to "control" or the first variant',
  ),
  minSessionsPerVariant: z.number().int().positive().default(30),
  decision: z
    .object({
      shipIf: UnitSchema.default(0.95).describe(
        'P(best) at or above which the variant is a ship candidate',
      ),
      killIf: UnitSchema.default(0.05).describe(
        'P(best) at or below which the variant is a kill candidate',
      ),
    })
    .prefault({}),
  alpha: z.number().gt(0).lt(1).default(0.05),
  clusterBy: z
    .array(z.enum(['persona', 'model', 'scenario']))
    .default(['persona', 'model'])
    .describe('Grouping factors treated as clusters when estimating uncertainty'),
  calibrationProfile: z.string().min(1).default('uncalibrated-v0'),
  materiality: MaterialitySchema.prefault({}).describe(
    'The materiality boundary: output fields a decision may turn on. Versioned under the requirements digest every result carries; see docs/receipts-and-findings.md',
  ),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export type AnalysisInput = z.input<typeof AnalysisSchema>;
