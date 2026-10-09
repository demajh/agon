import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_REGISTRY,
  ConfigError,
  REQUIRED_SETS,
  ValidationError,
  stampWarehouseRow,
  timeToReconcileMs,
  type ContractRegistry,
} from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { RowGate, loadGateSnapshot, saveGateSnapshot } from './gate.js';

type MetricRow = Record<string, unknown> & { session_id: string; metric_id: string };

const HOUR = 3_600_000;

function clock(start = '2026-10-09T00:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function row(id: string, overrides: Record<string, unknown> = {}): MetricRow {
  return {
    ...stampWarehouseRow('metric_value_row', {
      session_id: id,
      run_id: 'run_1',
      variant: 'control',
      metric_id: 'activation',
      value: 1,
    }),
    ...overrides,
  };
}

const keyOf = (r: MetricRow) => `${r.session_id}:${r.metric_id}`;

/** Generation 2 adds a v2 set with one more field and a vendor set narrower than ours. */
const GEN2: ContractRegistry = {
  generation: 2,
  sets: {
    ...CONTRACT_REGISTRY.sets,
    'agon.metric_value_row.2': {
      version: '2027-01-01.1',
      fields: [...REQUIRED_SETS['agon.metric_value_row.1']!.fields, 'unit'],
    },
    'vendor.metric_value_row.1': {
      version: '2027-01-01.1',
      fields: ['session_id', 'run_id', 'variant', 'metric_id'],
    },
  },
};

function gate(c = clock(), registry = CONTRACT_REGISTRY, ttl = HOUR) {
  return new RowGate<MetricRow>({
    registry,
    readerSet: 'agon.metric_value_row.1',
    quarantineTtlMs: ttl,
    keyOf,
    now: c.now,
  });
}

describe('RowGate', () => {
  it('serves accepted rows and refuses a reader that names an unknown set', () => {
    const g = gate();
    expect(g.ingest(row('s1'))).toMatchObject({ status: 'accepted', key: 's1:activation' });
    expect(g.serve('s1:activation')).toEqual({ ok: true, key: 's1:activation', row: row('s1') });
    expect(g.serve('nope')).toBeUndefined();
    expect(
      () =>
        new RowGate({ registry: CONTRACT_REGISTRY, readerSet: 'agon.nope.1', quarantineTtlMs: 1 }),
    ).toThrow(ConfigError);
  });

  it('REQUIRED_SET_UNRESOLVED: quarantines rows with an unknown id (and unstamped rows), never serving them', () => {
    const g = gate();
    const unknown = row('s2', { required_set: 'agon.metric_value_row.2', unit: 'ms' });
    expect(g.ingest(unknown)).toMatchObject({
      status: 'quarantined',
      code: 'REQUIRED_SET_UNRESOLVED',
      requiredSet: 'agon.metric_value_row.2',
      expiresAt: '2026-10-09T01:00:00.000Z',
    });
    expect(g.serve('s2:activation')).toEqual({
      ok: false,
      key: 's2:activation',
      code: 'REQUIRED_SET_UNRESOLVED',
      requiredSet: 'agon.metric_value_row.2',
    });
    const unstamped = {
      session_id: 's3',
      run_id: 'r',
      variant: 'v',
      metric_id: 'activation',
      value: 1,
    };
    expect(g.ingest(unstamped)).toMatchObject({
      status: 'quarantined',
      requiredSet: '(unstamped)',
    });
    expect(g.quarantined().map((q) => q.key)).toEqual(['s2:activation', 's3:activation']);
    expect(g.acceptedKeys()).toEqual([]);
  });

  it('REQUIRED_SET_NOT_SUPERSET: hard-rejects on ingest and on serve', () => {
    const g = gate(clock(), GEN2);
    const narrow = row('s4', { required_set: 'vendor.metric_value_row.1' });
    expect(g.ingest(narrow)).toEqual({
      status: 'rejected',
      key: 's4:activation',
      code: 'REQUIRED_SET_NOT_SUPERSET',
      requiredSet: 'vendor.metric_value_row.1',
      missing: ['value'],
    });
    expect(g.serve('s4:activation')).toEqual({
      ok: false,
      key: 's4:activation',
      code: 'REQUIRED_SET_NOT_SUPERSET',
      requiredSet: 'vendor.metric_value_row.1',
    });
    // a superset of the reader's set is fine
    expect(
      g.ingest(row('s5', { required_set: 'agon.metric_value_row.2', unit: 'ms' })).status,
    ).toBe('accepted');
  });

  it('replays the quarantine when the registry generation bumps', () => {
    const g = gate();
    g.ingest(row('s6', { required_set: 'agon.metric_value_row.2', unit: 'ms' }));
    g.ingest(row('s7', { required_set: 'vendor.metric_value_row.1' }));
    g.ingest(row('s8', { required_set: 'agon.metric_value_row.3' }));
    expect(g.quarantined()).toHaveLength(3);
    const replay = g.bump(GEN2);
    expect(replay.generation).toBe(2);
    expect(replay.accepted.map((a) => a.key)).toEqual(['s6:activation']);
    expect(replay.rejected).toEqual([
      { key: 's7:activation', requiredSet: 'vendor.metric_value_row.1', missing: ['value'] },
    ]);
    expect(replay.stillQuarantined).toBe(1);
    expect(replay.reconciled).toEqual([]);
    expect(g.serve('s6:activation')?.ok).toBe(true);
    expect(g.serve('s7:activation')).toMatchObject({ code: 'REQUIRED_SET_NOT_SUPERSET' });
    expect(g.serve('s8:activation')).toMatchObject({ code: 'REQUIRED_SET_UNRESOLVED' });
    expect(() => g.bump(CONTRACT_REGISTRY)).toThrow(ValidationError);
  });

  it('QUARANTINE_EXPIRED: rejects with its own code and counts the id in the lag ledger until a bump reconciles it', () => {
    const c = clock();
    const g = gate(c);
    g.ingest(row('s9', { required_set: 'agon.metric_value_row.2', unit: 'ms' }));
    c.advance(30 * 60_000);
    g.ingest(row('s10', { required_set: 'agon.metric_value_row.2', unit: 'ms' }));
    expect(g.serve('s9:activation')).toMatchObject({ code: 'REQUIRED_SET_UNRESOLVED' });
    c.advance(HOUR); // both past their TTL
    expect(g.serve('s9:activation')).toEqual({
      ok: false,
      key: 's9:activation',
      code: 'QUARANTINE_EXPIRED',
      requiredSet: 'agon.metric_value_row.2',
    });
    expect(g.quarantined()).toEqual([]);
    expect(g.lagLedger()).toEqual([
      {
        requiredSet: 'agon.metric_value_row.2',
        generation: 1,
        rows: 2,
        firstSeenAt: '2026-10-09T00:00:00.000Z',
        expiredAt: '2026-10-09T01:30:00.000Z',
      },
    ]);
    c.advance(2 * HOUR);
    const replay = g.bump(GEN2);
    expect(replay.accepted).toEqual([]);
    expect(replay.reconciled).toHaveLength(1);
    const [entry] = g.lagLedger();
    expect(entry).toMatchObject({
      rows: 2,
      reconciledAt: '2026-10-09T03:30:00.000Z',
      reconciledGeneration: 2,
    });
    expect(timeToReconcileMs(entry!)).toBe(2 * HOUR);
    // closed, not deleted: the denominator survives the replay, and the expired rows stay out
    expect(g.lagLedger()).toHaveLength(1);
    expect(g.serve('s9:activation')).toMatchObject({ code: 'QUARANTINE_EXPIRED' });
    expect(g.acceptedKeys()).toEqual([]);
    // re-ingesting the row is the only way back in, and it goes through the normal check
    expect(
      g.ingest(row('s9', { required_set: 'agon.metric_value_row.2', unit: 'ms' })).status,
    ).toBe('accepted');
    expect(g.lagLedger()).toHaveLength(1);
  });

  it('round-trips through a snapshot file, replaying on restore when the registry moved on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agon-gate-'));
    try {
      const c = clock();
      const g = gate(c);
      g.ingest(row('a'));
      g.ingest(row('b', { required_set: 'agon.metric_value_row.2', unit: 'ms' }));
      g.ingest(row('c', { required_set: 'agon.metric_value_row.9' }));
      c.advance(2 * HOUR);
      g.sweep();
      g.ingest(row('d', { required_set: 'agon.metric_value_row.2', unit: 'ms' }));
      const path = join(dir, '.agon', 'gate', 'metrics.json');
      await saveGateSnapshot(path, g);
      const snapshot = await loadGateSnapshot(path);
      expect(snapshot?.version).toBe(1);
      expect(snapshot?.lagLedger).toHaveLength(2);

      const same = RowGate.restore<MetricRow>(snapshot!, {
        registry: CONTRACT_REGISTRY,
        keyOf,
        now: c.now,
      });
      expect(same.serve('a:activation')?.ok).toBe(true);
      expect(same.serve('b:activation')).toMatchObject({ code: 'QUARANTINE_EXPIRED' });
      expect(same.serve('d:activation')).toMatchObject({ code: 'REQUIRED_SET_UNRESOLVED' });

      const moved = RowGate.restore<MetricRow>(snapshot!, { registry: GEN2, keyOf, now: c.now });
      expect(moved.generation).toBe(2);
      expect(moved.serve('d:activation')?.ok).toBe(true);
      expect(moved.serve('b:activation')).toMatchObject({ code: 'QUARANTINE_EXPIRED' });
      const ledger = moved.lagLedger();
      expect(
        ledger.find((e) => e.requiredSet === 'agon.metric_value_row.2')?.reconciledAt,
      ).toBeDefined();
      expect(
        ledger.find((e) => e.requiredSet === 'agon.metric_value_row.9')?.reconciledAt,
      ).toBeUndefined();
      expect(await loadGateSnapshot(join(dir, 'missing.json'))).toBeUndefined();
      const corrupt = join(dir, 'corrupt.json');
      await writeFile(corrupt, JSON.stringify({ ...snapshot, version: 2 }));
      await expect(loadGateSnapshot(corrupt)).rejects.toThrow(ValidationError);
      await writeFile(corrupt, '{ not json');
      await expect(loadGateSnapshot(corrupt)).rejects.toThrow(/not JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
