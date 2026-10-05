import { z } from 'zod';
import { SlugSchema } from './common.js';

const base = {
  id: SlugSchema,
  name: z.string().optional(),
  primary: z.boolean().default(false),
  direction: z
    .enum(['increase', 'decrease'])
    .optional()
    .describe('Which way is better; defaults per type'),
};

export const MetricSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('conversion'), event: z.string().min(1) }),
  z.object({ ...base, type: z.literal('count'), event: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('duration'),
    from: z.string().min(1).default('session_start'),
    to: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal('steps') }),
  z.object({
    ...base,
    type: z.literal('score'),
    source: z.enum(['judge']).default('judge'),
    score: z.enum(['satisfaction', 'frustration']).default('satisfaction'),
  }),
]);
export type Metric = z.infer<typeof MetricSchema>;
export type MetricInput = z.input<typeof MetricSchema>;

/** Always computed, whether or not the config lists it: did the scenario's success criterion fire. */
export const SCENARIO_SUCCESS_METRIC_ID = 'scenario_success';

export function metricDirection(m: Metric): 'increase' | 'decrease' {
  if (m.direction) return m.direction;
  if (m.type === 'duration' || m.type === 'steps') return 'decrease';
  if (m.type === 'score' && m.score === 'frustration') return 'decrease';
  return 'increase';
}

export function isBinaryMetric(m: Metric): boolean {
  return m.type === 'conversion';
}
