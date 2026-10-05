import { DecisionSchema, NotFoundError } from '@agon/spec';
import { expect, it } from 'vitest';
import { decisions } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at } from '../testing/fixtures.js';

describeDb('decisions', () => {
  const t = useTestDb();

  it('round-trips insert -> get with defaults applied', async () => {
    const created = await decisions.insert(t.db, {
      kind: 'pause',
      squadId: 'sqd_blue',
      policyId: 'pause-laggards',
      actor: 'auto',
      rationale: 'p_best over the last 5 runs is 0.04',
      evidence: { runIds: ['run_1', 'run_2'], metrics: { p_best_rolling: 0.04 } },
      payload: { allocation: 0.1 },
      createdAt: at(0),
    });
    expect(created.id).toMatch(/^dec_[0-9a-z]{16}$/);
    expect(created).toEqual(
      DecisionSchema.parse({
        id: created.id,
        kind: 'pause',
        status: 'proposed',
        squadId: 'sqd_blue',
        policyId: 'pause-laggards',
        actor: 'auto',
        rationale: 'p_best over the last 5 runs is 0.04',
        evidence: { runIds: ['run_1', 'run_2'], resultIds: [], metrics: { p_best_rolling: 0.04 } },
        payload: { allocation: 0.1 },
        createdAt: at(0),
      }),
    );
    expect(await decisions.get(t.db, created.id)).toEqual(created);
    const minimal = await decisions.insert(t.db, {
      kind: 'notify',
      actor: 'human',
      rationale: 'fyi',
    });
    expect(minimal.evidence).toEqual({ runIds: [], resultIds: [], metrics: {} });
    expect(minimal.payload).toEqual({});
    await expect(decisions.get(t.db, 'dec_missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists newest first with filters and pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await decisions.insert(t.db, {
        id: `dec_${i}`,
        kind: i % 2 === 0 ? 'pause' : 'reallocate',
        status: i === 4 ? 'approved' : 'proposed',
        squadId: i < 3 ? 'sqd_blue' : 'sqd_red',
        policyId: i < 3 ? 'pause-laggards' : undefined,
        actor: i === 4 ? 'human' : 'auto',
        rationale: `decision ${i}`,
        createdAt: at(i),
      });
    }
    const page1 = await decisions.list(t.db, { limit: 2 });
    expect(page1.items.map((d) => d.id)).toEqual(['dec_4', 'dec_3']);
    const page2 = await decisions.list(t.db, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((d) => d.id)).toEqual(['dec_2', 'dec_1']);
    const page3 = await decisions.list(t.db, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((d) => d.id)).toEqual(['dec_0']);
    expect(page3.nextCursor).toBeUndefined();

    const blue = await decisions.list(t.db, { squadId: 'sqd_blue' });
    expect(blue.items.map((d) => d.id)).toEqual(['dec_2', 'dec_1', 'dec_0']);
    const pauses = await decisions.list(t.db, { kind: 'pause', status: 'proposed' });
    expect(pauses.items.map((d) => d.id)).toEqual(['dec_2', 'dec_0']);
    const human = await decisions.list(t.db, { actor: 'human' });
    expect(human.items.map((d) => d.id)).toEqual(['dec_4']);
    const policy = await decisions.list(t.db, { policyId: 'pause-laggards' });
    expect(policy.items).toHaveLength(3);
  });

  it('advances status and stamps decision and execution times', async () => {
    const created = await decisions.insert(t.db, { kind: 'kill', actor: 'auto', rationale: 'bad' });
    const approved = await decisions.setStatus(t.db, created.id, 'approved');
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).toBeDefined();
    expect(approved.executedAt).toBeUndefined();

    const executed = await decisions.setStatus(t.db, created.id, 'executed', {
      executedAt: at(10),
    });
    expect(executed).toMatchObject({
      status: 'executed',
      decidedAt: approved.decidedAt,
      executedAt: at(10),
    });

    const other = await decisions.insert(t.db, { kind: 'pause', actor: 'auto', rationale: 'meh' });
    const rejected = await decisions.setStatus(t.db, other.id, 'rejected', { decidedAt: at(5) });
    expect(rejected).toMatchObject({ status: 'rejected', decidedAt: at(5) });
    const failed = await decisions.setStatus(t.db, other.id, 'failed', { error: 'webhook 500' });
    expect(failed).toMatchObject({ status: 'failed', error: 'webhook 500' });
    await expect(decisions.setStatus(t.db, 'dec_missing', 'approved')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
