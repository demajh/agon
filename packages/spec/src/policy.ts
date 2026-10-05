import { z } from 'zod';
import { DurationSchema, IdSchema, SlugSchema, TimestampSchema, UnitSchema } from './common.js';

export const PolicyActionSchema = z.enum(['reallocate', 'pause', 'resume', 'kill', 'notify']);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicyTriggerSchema = z.enum(['run.completed', 'result.ready', 'schedule']);

export const PolicySchema = z.object({
  id: SlugSchema,
  name: z.string().optional(),
  on: PolicyTriggerSchema.default('result.ready'),
  when: z
    .string()
    .optional()
    .describe('Boolean expression over squad and result metrics, e.g. "squad.p_best_rolling(5) < 0.10"'),
  then: PolicyActionSchema,
  method: z.enum(['thompson']).default('thompson'),
  floor: UnitSchema.default(0.1).describe('Minimum allocation any active squad keeps'),
  approval: z.enum(['auto', 'human']).optional().describe('Defaults to human for pause/kill, auto otherwise'),
  cooldown: DurationSchema.default('24h'),
  maxPerDay: z.number().int().positive().default(5),
});
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

export function policyApproval(p: Policy): 'auto' | 'human' {
  return p.approval ?? (p.then === 'kill' || p.then === 'pause' ? 'human' : 'auto');
}

export const DecisionStatusSchema = z.enum(['proposed', 'approved', 'rejected', 'executed', 'failed']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

/** Append-only record of every governance action Agon proposes or takes. */
export const DecisionSchema = z.object({
  id: IdSchema,
  kind: PolicyActionSchema,
  status: DecisionStatusSchema,
  squadId: IdSchema.optional(),
  policyId: SlugSchema.optional(),
  actor: z.enum(['auto', 'human']),
  rationale: z.string().min(1),
  evidence: z
    .object({
      runIds: z.array(IdSchema).default([]),
      resultIds: z.array(IdSchema).default([]),
      metrics: z.record(z.string(), z.number()).default({}),
    })
    .prefault({}),
  payload: z.record(z.string(), z.unknown()).default({}).describe('Action parameters, e.g. the new allocation'),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  executedAt: TimestampSchema.optional(),
  error: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;
