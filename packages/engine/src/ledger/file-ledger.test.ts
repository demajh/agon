import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTrials, summarizeLedger, type LedgerEntry } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { FileLedger } from './file-ledger.js';

const HASH = 'a'.repeat(64);

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    sampleHash: HASH,
    runId: 'run_1',
    variant: 'treatment',
    variantKey: 'treatment@000000000001',
    role: 'treatment',
    event: 'started',
    at: '2026-10-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('FileLedger', () => {
  it('appends entries to one JSONL file per sample hash and reads them back', async () => {
    const ledger = new FileLedger(join(mkdtempSync(join(tmpdir(), 'agon-ledger-')), 'ledger'));
    expect(await ledger.list(HASH)).toEqual([]);
    expect(await ledger.find()).toEqual([]);
    await ledger.append(entry({ variant: 'control', variantKey: 'control@0', role: 'control' }));
    await ledger.append(entry({}));
    await ledger.append(entry({ event: 'completed', at: '2026-10-09T10:05:00.000Z' }));
    await ledger.append(
      entry({ sampleHash: 'b'.repeat(64), runId: 'run_2', variantKey: 'treatment@000000000002' }),
    );
    const listed = await ledger.list(HASH);
    expect(listed).toHaveLength(3);
    expect(listed.map((e) => e.event)).toEqual(['started', 'started', 'completed']);
    expect(readFileSync(ledger.path(HASH), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(await ledger.find()).toEqual([HASH, 'b'.repeat(64)]);
    expect(await ledger.find('b')).toEqual(['b'.repeat(64)]);
    await expect(ledger.list('../etc/passwd')).rejects.toThrow(/invalid sample hash/);
    await expect(ledger.append(entry({ sampleHash: '' }))).rejects.toThrow();
  });
});

describe('countTrials and summarizeLedger', () => {
  it('counts distinct treatment variants ever started, discarded ones included', () => {
    const entries: LedgerEntry[] = [
      entry({ variant: 'control', variantKey: 'control@0', role: 'control' }),
      entry({}),
      entry({ event: 'discarded', at: '2026-10-09T10:01:00.000Z' }),
      entry({
        runId: 'run_2',
        variantKey: 'treatment@000000000002',
        at: '2026-10-09T11:00:00.000Z',
      }),
      entry({
        runId: 'run_2',
        variantKey: 'treatment@000000000002',
        event: 'completed',
        at: '2026-10-09T11:05:00.000Z',
      }),
      entry({ runId: 'run_3', at: '2026-10-09T12:00:00.000Z' }), // the discarded one, tried again
      entry({ runId: 'run_3', event: 'promoted', at: '2026-10-09T12:05:00.000Z' }),
    ];
    expect(countTrials(entries)).toBe(2);
    expect(countTrials([])).toBe(1);
    expect(countTrials([entries[0] as LedgerEntry])).toBe(1);
    const summary = summarizeLedger(entries);
    expect(summary.sampleHash).toBe(HASH);
    expect(summary.trials).toBe(2);
    expect(summary.entries).toBe(7);
    expect(summary.variants.map((v) => [v.variantKey, v.runs, v.lastEvent, v.discarded])).toEqual([
      ['control@0', ['run_1'], 'started', false],
      ['treatment@000000000001', ['run_1', 'run_3'], 'promoted', false],
      ['treatment@000000000002', ['run_2'], 'completed', false],
    ]);
    expect(summarizeLedger(entries.slice(0, 3)).variants[1]?.discarded).toBe(true);
  });
});
