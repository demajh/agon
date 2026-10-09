import { ConflictError, FindingSchema, NotFoundError } from '@agon/spec';
import { expect, it } from 'vitest';
import { environments, findings, results, runs } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at, config, makeResult, makeRun } from '../testing/fixtures.js';

const SETTLEMENT = {
  predicate: 'no refund exceeds its original charge in 30 days of live traffic',
  observer: 'finance-ops',
};

describeDb('findings', () => {
  const t = useTestDb();

  async function receipt(): Promise<string> {
    const env = await environments.create(t.db, { config });
    const run = await runs.create(t.db, makeRun(env.id));
    const stored = await results.insert(
      t.db,
      makeResult(run, { requirementsDigest: 'a'.repeat(64) }),
    );
    return stored.id;
  }

  it('files an open finding against a receipt and reads it back', async () => {
    const receiptId = await receipt();
    const filed = await findings.insert(t.db, {
      receiptId,
      invariant: 'a refund never exceeds the original charge',
      impact: 'three customers were over-refunded by the shipped variant',
      closureOwner: 'payments-team',
      settlement: SETTLEMENT,
      requirementsDigest: 'a'.repeat(64),
      createdAt: at(0),
    });
    expect(filed.id).toMatch(/^fnd_[0-9a-z]{16}$/);
    expect(filed).toEqual(
      FindingSchema.parse({
        id: filed.id,
        receiptId,
        invariant: 'a refund never exceeds the original charge',
        impact: 'three customers were over-refunded by the shipped variant',
        closureOwner: 'payments-team',
        status: 'open',
        settlement: SETTLEMENT,
        requirementsDigest: 'a'.repeat(64),
        createdAt: at(0),
      }),
    );
    expect(filed.closedAt).toBeUndefined();
    expect(await findings.get(t.db, filed.id)).toEqual(filed);
    await expect(findings.get(t.db, 'fnd_missing')).rejects.toBeInstanceOf(NotFoundError);
    // a finding names its invariant and how it will be settled; neither may be blank
    const blank = { receiptId, impact: 'x', closureOwner: 'y' };
    await expect(
      findings.insert(t.db, { ...blank, invariant: '', settlement: SETTLEMENT }),
    ).rejects.toThrow();
    await expect(
      findings.insert(t.db, {
        ...blank,
        invariant: 'x',
        settlement: { predicate: '', observer: 'z' },
      }),
    ).rejects.toThrow();
  });

  it('closes a finding once, as fixed or tolerated, and never reopens it', async () => {
    const receiptId = await receipt();
    const open = () =>
      findings.insert(t.db, {
        receiptId,
        invariant: 'checkout total equals the sum of its lines',
        impact: 'rounding drift on multi-currency carts',
        closureOwner: 'checkout-team',
        settlement: SETTLEMENT,
        createdAt: at(1),
      });
    const a = await open();
    const fixed = await findings.close(t.db, a.id, 'closed_fixed', at(60));
    expect(fixed).toMatchObject({ status: 'closed_fixed', closedAt: at(60) });
    await expect(findings.close(t.db, a.id, 'closed_tolerated')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await findings.get(t.db, a.id)).toEqual(fixed);
    const b = await open();
    expect((await findings.close(t.db, b.id, 'closed_tolerated', at(61))).status).toBe(
      'closed_tolerated',
    );
    await expect(findings.close(t.db, 'fnd_missing', 'closed_fixed')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('lists newest first, by receipt and by status, with pagination', async () => {
    const r1 = await receipt();
    const r2 = await receipt();
    for (let i = 0; i < 5; i++) {
      await findings.insert(t.db, {
        id: `fnd_${i}`,
        receiptId: i < 3 ? r1 : r2,
        invariant: `invariant ${i}`,
        impact: 'impact',
        closureOwner: 'owner',
        settlement: SETTLEMENT,
        createdAt: at(i),
      });
    }
    await findings.close(t.db, 'fnd_1', 'closed_fixed', at(10));
    const page1 = await findings.list(t.db, { limit: 2 });
    expect(page1.items.map((f) => f.id)).toEqual(['fnd_4', 'fnd_3']);
    const page2 = await findings.list(t.db, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((f) => f.id)).toEqual(['fnd_2', 'fnd_1']);
    expect((await findings.list(t.db, { receiptId: r1 })).items.map((f) => f.id)).toEqual([
      'fnd_2',
      'fnd_1',
      'fnd_0',
    ]);
    expect((await findings.list(t.db, { status: 'open', receiptId: r1 })).items).toHaveLength(2);
    expect((await findings.list(t.db, { status: 'closed_fixed' })).items.map((f) => f.id)).toEqual([
      'fnd_1',
    ]);
  });
});
