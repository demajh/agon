import { z } from 'zod';
import { IdSchema, TimestampSchema, hashValue } from './common.js';
import type { AgonConfig } from './config.js';
import { ConflictError } from './errors.js';

/**
 * Results are receipts. Each one carries `requirementsDigest`, a hash of the parts of the
 * configuration that decided its acceptance. When an incident shows those requirements were too
 * weak, the requirements change (a new digest for future attempts) and the receipt is never
 * rewritten: supersede the policy, never the receipt.
 */

/** The parts of a config that decide whether a result is accepted. Variants are deliberately absent. */
export function requirementsOf(
  config: Pick<AgonConfig, 'analysis' | 'metrics' | 'policies'>,
): Pick<AgonConfig, 'analysis' | 'metrics' | 'policies'> {
  return { analysis: config.analysis, metrics: config.metrics, policies: config.policies };
}

/**
 * sha256 over the canonical JSON of the analysis section (materiality boundary included), the
 * metrics and the policies. Changing a metric or a policy changes it; changing a variant does not.
 */
export function requirementsDigest(
  config: Pick<AgonConfig, 'analysis' | 'metrics' | 'policies'>,
): string {
  return hashValue(requirementsOf(config));
}

export const FindingStatusSchema = z.enum(['open', 'closed_fixed', 'closed_tolerated']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

/**
 * How a finding is settled: the predicate someone will apply and who applies it. Named on the
 * record so the effect never stamps its own finality. At close the observer's own stamp may
 * travel with it: when they saw the condition hold or fail, and the version pin they evaluated it
 * under. Both are declared by the observer; `closedAt` is stamped by the repository.
 */
export const SettlementSchema = z.object({
  predicate: z
    .string()
    .min(1)
    .describe('The observable condition under which the finding counts as settled'),
  observer: z.string().min(1).describe('Who applies the predicate'),
  observedAt: TimestampSchema.optional().describe(
    'When the observer saw the condition hold or fail; declared by the observer at close',
  ),
  observedUnder: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The version pin (a release, a commit, a requirements digest) the observer evaluated the predicate under; declared at close',
    ),
});
export type Settlement = z.infer<typeof SettlementSchema>;

/** What the observer declares when a finding is closed. The repository stamps `closedAt` itself. */
export const SettlementObservationSchema = SettlementSchema.pick({
  observedAt: true,
  observedUnder: true,
});
export type SettlementObservation = z.infer<typeof SettlementObservationSchema>;

/** A finding names a receipt, carries the new invariant and a closure owner. */
export const FindingSchema = z
  .object({
    id: IdSchema,
    receiptId: IdSchema.describe('The result (the receipt) this finding names'),
    invariant: z.string().min(1).describe('The invariant the incident showed was missing'),
    impact: z.string().min(1),
    closureOwner: z.string().min(1),
    status: FindingStatusSchema.default('open'),
    settlement: SettlementSchema,
    requirementsDigest: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The requirements version the receipt was accepted under; naming it here marks it superseded for future attempts',
      ),
    createdAt: TimestampSchema,
    closedAt: TimestampSchema.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.status === 'open' && f.closedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['closedAt'],
        message: 'an open finding has no closedAt',
      });
    }
    if (f.status !== 'open' && f.closedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['closedAt'],
        message: 'a closed finding needs closedAt',
      });
    }
    if (
      f.status === 'open' &&
      (f.settlement.observedAt !== undefined || f.settlement.observedUnder !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['settlement'],
        message: 'an open finding has no settlement observation; the observer declares it at close',
      });
    }
  });
export type Finding = z.infer<typeof FindingSchema>;
export type FindingInput = z.input<typeof FindingSchema>;

export const ClosedFindingStatusSchema = z.enum(['closed_fixed', 'closed_tolerated']);
export type ClosedFindingStatus = z.infer<typeof ClosedFindingStatusSchema>;

/**
 * Closes a finding as fixed (the invariant now holds) or tolerated (it does not, and someone owns
 * that). `at` is the closing time the repository stamps; `observation` is what the observer
 * declares, when they saw the predicate hold or fail and under which version pin. A closed
 * finding is never reopened by this path; create a new one.
 */
export function closeFinding(
  finding: Finding,
  status: ClosedFindingStatus,
  at: string,
  observation: SettlementObservation = {},
): Finding {
  if (finding.status !== 'open') {
    throw new ConflictError(`finding ${finding.id} is already ${finding.status}`);
  }
  const observed = SettlementObservationSchema.parse(observation);
  const settlement: Settlement = { ...finding.settlement };
  if (observed.observedAt !== undefined) settlement.observedAt = observed.observedAt;
  if (observed.observedUnder !== undefined) settlement.observedUnder = observed.observedUnder;
  return FindingSchema.parse({ ...finding, status, closedAt: at, settlement });
}
