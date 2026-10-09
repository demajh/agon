import { LedgerEntrySchema } from '@agon/spec';
import type { EvaluationLedger, LedgerEntry } from '@agon/spec';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import { parseRow, toDate, toIso } from '../internal.js';
import { evaluationLedger } from '../schema.js';
import type { EvaluationLedgerRow } from '../schema.js';

export function toEntry(row: EvaluationLedgerRow): LedgerEntry {
  return parseRow(
    LedgerEntrySchema,
    {
      sampleHash: row.sampleHash,
      runId: row.runId,
      variant: row.variant,
      variantKey: row.variantKey,
      role: row.role,
      event: row.event,
      at: toIso(row.at),
      ...(row.note === null ? {} : { note: row.note }),
    },
    'ledger entry',
    String(row.id),
  );
}

/** Appends one entry. The ledger is append-only: there is no update and no delete. */
export async function append(db: Db, entry: LedgerEntry): Promise<LedgerEntry> {
  const parsed = LedgerEntrySchema.parse(entry);
  const rows = await guard(() =>
    db
      .insert(evaluationLedger)
      .values({
        sampleHash: parsed.sampleHash,
        runId: parsed.runId,
        variant: parsed.variant,
        variantKey: parsed.variantKey,
        role: parsed.role,
        event: parsed.event,
        at: toDate(parsed.at),
        note: parsed.note ?? null,
      })
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insert ledger entry returned no row');
  return toEntry(row);
}

/** Every entry against a sample, oldest first. */
export async function listBySample(db: Db, sampleHash: string): Promise<LedgerEntry[]> {
  const rows = await db
    .select()
    .from(evaluationLedger)
    .where(eq(evaluationLedger.sampleHash, sampleHash))
    .orderBy(asc(evaluationLedger.at), asc(evaluationLedger.id));
  return rows.map(toEntry);
}

/** Every entry a run wrote, oldest first. */
export async function listByRun(db: Db, runId: string): Promise<LedgerEntry[]> {
  const rows = await db
    .select()
    .from(evaluationLedger)
    .where(eq(evaluationLedger.runId, runId))
    .orderBy(asc(evaluationLedger.at), asc(evaluationLedger.id));
  return rows.map(toEntry);
}

/** The engine's `EvaluationLedger` backed by the `evaluation_ledger` table. */
export function createDbLedger(db: Db): EvaluationLedger {
  return {
    async append(entry: LedgerEntry): Promise<void> {
      await append(db, entry);
    },
    list: (sampleHash: string) => listBySample(db, sampleHash),
  };
}
