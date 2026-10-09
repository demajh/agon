import { z } from 'zod';
import { TimestampSchema, UnitSchema } from './common.js';

/**
 * The live-window recorder (docs/live-window-recorder.md): the first hours after a release are
 * the measurement every pre-release model is later checked against. Agon does not capture live
 * traffic itself; this module fixes the input it expects (`LiveWindow`, one file for the
 * pre-release baseline and one for the live window) and the report `agon-stats live-window`
 * writes (`LiveWindowReport`, `kind: measurement`).
 */

export const LIVE_WINDOW_SERIES = [
  'latencyMs',
  'retryRate',
  'abandonmentRate',
  'queueDepth',
] as const;
export type LiveWindowSeriesName = (typeof LIVE_WINDOW_SERIES)[number];

/** Four aligned series sampled at one grain: sample i of every series covers the same interval. */
export const LiveWindowSeriesSchema = z.object({
  latencyMs: z
    .array(z.number().nonnegative())
    .describe('Latency per interval (p50 or mean, the same statistic in both windows)'),
  retryRate: z.array(UnitSchema).describe('Retries per request in the interval'),
  abandonmentRate: z
    .array(UnitSchema)
    .describe('Abandoned requests or sessions per started one in the interval'),
  queueDepth: z
    .array(z.number().nonnegative())
    .describe('Depth of the queue where supply and demand meet, sampled at interval end'),
});
export type LiveWindowSeries = z.infer<typeof LiveWindowSeriesSchema>;

export const LiveWindowSchema = z
  .object({
    capacity: z
      .string()
      .min(1)
      .describe(
        'Capacity label the window ran at, e.g. "4 replicas"; the baseline and the live window must carry the same one',
      ),
    grainMs: z
      .number()
      .int()
      .positive()
      .describe('Interval length of every sample; the baseline and the live window must match'),
    startedAt: TimestampSchema.optional(),
    series: LiveWindowSeriesSchema,
  })
  .superRefine((w, ctx) => {
    const lengths = LIVE_WINDOW_SERIES.map((name) => w.series[name].length);
    if (new Set(lengths).size !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['series'],
        message: `series must be aligned: lengths ${lengths.join(', ')}`,
      });
    }
    if ((lengths[0] ?? 0) < 2) {
      ctx.addIssue({ code: 'custom', path: ['series'], message: 'need at least two samples' });
    }
  });
export type LiveWindow = z.infer<typeof LiveWindowSchema>;
export type LiveWindowInput = z.input<typeof LiveWindowSchema>;

const EdgesSchema = z
  .array(z.number())
  .refine((edges) => edges.every((v, i) => i === 0 || (edges[i - 1] as number) < v), {
    message: 'edges must increase',
  });

const EdgesPerSeriesSchema = z.object({
  latencyMs: EdgesSchema,
  retryRate: EdgesSchema,
  abandonmentRate: EdgesSchema,
  queueDepth: EdgesSchema,
});

/**
 * Declared bucket edges (`agon-stats live-window --buckets`), instead of the default bands at the
 * baseline's 90th percentile (coarse) and 50th, 90th and 99th (fine). A value equal to an edge
 * falls in the lower bucket. `fine` defaults to `coarse` and must contain every coarse edge, so a
 * decomposed state stays inside its coarse cluster.
 */
export const LiveWindowBucketsSchema = z
  .object({ coarse: EdgesPerSeriesSchema, fine: EdgesPerSeriesSchema.optional() })
  .superRefine((b, ctx) => {
    if (b.fine === undefined) return;
    for (const name of LIVE_WINDOW_SERIES) {
      const fine = new Set(b.fine[name]);
      if (!b.coarse[name].every((edge) => fine.has(edge))) {
        ctx.addIssue({
          code: 'custom',
          path: ['fine', name],
          message: `fine edges for ${name} must contain every coarse edge`,
        });
      }
    }
  });
export type LiveWindowBuckets = z.infer<typeof LiveWindowBucketsSchema>;

/** A state as one band label per series, e.g. `{ latencyMs: "p99..", retryRate: "..p50", ... }`. */
export const StateLabelSchema = z.record(z.string(), z.string());

/**
 * One transition that was improbable in the baseline and is now, decisively, the most likely
 * successor of its state in the live window. The direction is the signal: `from` -> `to`.
 */
export const GateSignalSchema = z.object({
  from: z.string().min(1).describe('State key, e.g. "latencyMs=p90..|retryRate=..p90|..."'),
  to: z.string().min(1),
  fromLabel: StateLabelSchema,
  toLabel: StateLabelSchema,
  liveProbability: UnitSchema.describe(
    'Share of the live transitions out of `from` that went to `to`',
  ),
  liveLowerBound: UnitSchema.describe(
    'Live bootstrap lower bound of that share at the family-wise level; the signal fires on this, not on the point estimate',
  ),
  runnerUpProbability: UnitSchema.describe('Share of the second most likely live successor'),
  marginLowerBound: z
    .number()
    .describe('Live bootstrap lower bound of the margin over the runner-up; positive when firing'),
  liveTransitions: z.number().int().nonnegative().describe('Transitions out of `from`, live'),
  baselineProbability: UnitSchema.describe(
    'Median of the bootstrap distribution of the baseline probability; 0 when the baseline never left `from`',
  ),
  baselinePercentileValue: UnitSchema.describe(
    'The parameterised percentile of that distribution, which the live lower bound exceeded',
  ),
  baselineTransitions: z
    .number()
    .int()
    .nonnegative()
    .describe('Transitions out of `from`, baseline'),
  baselineSuccessor: z
    .string()
    .nullable()
    .describe("The baseline's most likely successor of `from`; null when it never left `from`"),
});
export type GateSignal = z.infer<typeof GateSignalSchema>;

export const LiveWindowGateStatusSchema = z.enum(['passed', 'fired', 'insufficient']);
export type LiveWindowGateStatus = z.infer<typeof LiveWindowGateStatusSchema>;

export const LiveWindowReportSchema = z.object({
  kind: z.literal('measurement'),
  schemaVersion: z.string().min(1),
  capacity: z.string().min(1),
  grainMs: z.number().int().positive(),
  baseline: z.object({ samples: z.number().int().positive() }),
  live: z.object({ samples: z.number().int().positive() }),
  parameters: z.object({
    percentile: z.number().min(50).lt(100),
    decomposeAbove: UnitSchema,
    minTransitions: z.number().int().positive(),
    bootstrapSamples: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
    buckets: z.enum(['baseline-quantiles', 'declared']),
  }),
  states: z.number().int().positive().describe('States in the (possibly decomposed) state space'),
  decomposed: z
    .array(z.string())
    .describe('Coarse states whose share of the live transitions exceeded decomposeAbove'),
  gate: z.object({
    status: LiveWindowGateStatusSchema.describe(
      'passed: states were tested and none fired; fired: at least one signal; insufficient: no state had minTransitions live transitions, so nothing was judged',
    ),
    statesTested: z.number().int().nonnegative(),
    liveLevel: z
      .number()
      .nullable()
      .describe(
        'Per-state percentile of the live-side bounds: 100 - (100 - percentile) / statesTested',
      ),
    signals: z.array(GateSignalSchema),
  }),
  computedAt: TimestampSchema,
  engine: z.object({ name: z.string(), version: z.string() }),
});
export type LiveWindowReport = z.infer<typeof LiveWindowReportSchema>;
