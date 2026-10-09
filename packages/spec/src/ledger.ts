import { z } from 'zod';
import { IdSchema, SlugSchema, TimestampSchema } from './common.js';

/**
 * The evaluation ledger: an append-only record of every variant ever evaluated against a sample
 * of simulated users and tasks, keyed by the sample's hash. The number of distinct variants in it
 * is the number of trials the decision must correct for; it belongs to the data, not to a session
 * or a run, because the search for a winner is adaptive and crosses both.
 */
export const LedgerEventSchema = z.enum([
  'started',
  'completed',
  'discarded',
  'promoted',
  'killed',
]);
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export const LedgerRoleSchema = z.enum(['control', 'treatment']);
export type LedgerRole = z.infer<typeof LedgerRoleSchema>;

export const LedgerEntrySchema = z.object({
  sampleHash: z.string().min(1),
  runId: IdSchema,
  variant: SlugSchema,
  variantKey: z
    .string()
    .min(1)
    .describe(
      '"<variant>@<hash of its spec>": a redeploy under the same name with another url, command, image, env or gitRef is a new trial',
    ),
  role: LedgerRoleSchema,
  event: LedgerEventSchema.describe(
    'started is written when evaluation begins, so abandoned runs still count; the others are appended later, never updated in place',
  ),
  at: TimestampSchema,
  note: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * M, the number of trials: distinct treatment variants ever started against the sample,
 * discarded ones included. Never below 1.
 */
export function countTrials(entries: readonly LedgerEntry[]): number {
  const keys = new Set(
    entries.filter((e) => e.event === 'started' && e.role === 'treatment').map((e) => e.variantKey),
  );
  return Math.max(1, keys.size);
}

export interface LedgerVariantSummary {
  variantKey: string;
  variant: string;
  role: LedgerRole;
  runs: string[];
  firstAt: string;
  lastAt: string;
  lastEvent: LedgerEvent;
  discarded: boolean;
}

export interface LedgerSummary {
  sampleHash: string | undefined;
  trials: number;
  entries: number;
  variants: LedgerVariantSummary[];
}

/** One row per variant key, in order of first appearance, with the trial count. */
export function summarizeLedger(entries: readonly LedgerEntry[]): LedgerSummary {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const byKey = new Map<string, LedgerVariantSummary>();
  for (const e of sorted) {
    const existing = byKey.get(e.variantKey);
    if (existing === undefined) {
      byKey.set(e.variantKey, {
        variantKey: e.variantKey,
        variant: e.variant,
        role: e.role,
        runs: [e.runId],
        firstAt: e.at,
        lastAt: e.at,
        lastEvent: e.event,
        discarded: e.event === 'discarded',
      });
      continue;
    }
    if (!existing.runs.includes(e.runId)) existing.runs.push(e.runId);
    existing.lastAt = e.at;
    existing.lastEvent = e.event;
    existing.discarded = e.event === 'discarded';
  }
  return {
    sampleHash: sorted[0]?.sampleHash,
    trials: countTrials(entries),
    entries: entries.length,
    variants: [...byKey.values()],
  };
}
