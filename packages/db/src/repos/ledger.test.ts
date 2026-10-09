import { countTrials, type LedgerEntry } from '@agon/spec';
import { expect, it } from 'vitest';
import { createDbLedger, ledger } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at } from '../testing/fixtures.js';

const HASH = 'c'.repeat(64);

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    sampleHash: HASH,
    runId: 'run_1',
    variant: 'treatment',
    variantKey: 'treatment@000000000001',
    role: 'treatment',
    event: 'started',
    at: at(0),
    ...overrides,
  };
}

describeDb('evaluation ledger', () => {
  const t = useTestDb();

  it('appends and lists entries by sample and by run, oldest first, without updating in place', async () => {
    const l = createDbLedger(t.db);
    await l.append(entry({ variant: 'control', variantKey: 'control@0', role: 'control' }));
    await l.append(entry({}));
    await l.append(entry({ event: 'completed', at: at(5), note: '2 sessions' }));
    await l.append(entry({ runId: 'run_2', variantKey: 'treatment@000000000002', at: at(10) }));
    await l.append(entry({ sampleHash: 'd'.repeat(64), runId: 'run_3', at: at(1) }));

    const listed = await l.list(HASH);
    expect(listed).toHaveLength(4);
    expect(listed.map((e) => [e.runId, e.event])).toEqual([
      ['run_1', 'started'],
      ['run_1', 'started'],
      ['run_1', 'completed'],
      ['run_2', 'started'],
    ]);
    expect(listed[2]?.note).toBe('2 sessions');
    expect(listed[0]?.note).toBeUndefined();
    expect(countTrials(listed)).toBe(2);
    expect((await ledger.listByRun(t.db, 'run_1')).map((e) => e.event)).toEqual([
      'started',
      'started',
      'completed',
    ]);
    expect(await l.list('e'.repeat(64))).toEqual([]);
    await expect(l.append(entry({ event: 'retracted' as LedgerEntry['event'] }))).rejects.toThrow();
  });
});
