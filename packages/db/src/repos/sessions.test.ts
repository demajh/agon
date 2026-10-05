import { ConflictError, NotFoundError } from '@agon/spec';
import type { Judgement, Run } from '@agon/spec';
import { expect, it } from 'vitest';
import { environments, runs, sessions, steps } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at, config, makeRun, makeSession, makeStep } from '../testing/fixtures.js';

const judgement: Judgement = {
  success: true,
  satisfaction: 4,
  frustration: 2,
  confidence: 0.8,
  summary: 'Signed up without trouble.',
};

describeDb('sessions', () => {
  const t = useTestDb();

  async function run(): Promise<Run> {
    const env = await environments.create(t.db, { config });
    return runs.create(t.db, makeRun(env.id));
  }

  it('round-trips upsert -> get and updates on a second upsert', async () => {
    const r = await run();
    const session = makeSession(r, 0);
    expect(await sessions.upsert(t.db, session)).toEqual(session);
    expect(await sessions.get(t.db, session.id)).toEqual(session);

    const finished = {
      ...session,
      status: 'finished' as const,
      outcome: 'success' as const,
      steps: 3,
      costUsd: 0.012,
      inputTokens: 3600,
      outputTokens: 240,
      metrics: { activation: 1, time_to_activate: 42.5 },
      judgement,
      finishedAt: at(30),
    };
    expect(await sessions.upsert(t.db, finished)).toEqual(finished);
    expect(await sessions.get(t.db, session.id)).toEqual(finished);
    await expect(sessions.get(t.db, 'ses_missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(sessions.upsert(t.db, makeSession(makeRun('env_x'), 0))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('enforces one session per (run, index)', async () => {
    const r = await run();
    await sessions.upsert(t.db, makeSession(r, 0));
    await expect(
      sessions.upsert(t.db, makeSession(r, 0, { id: 'ses_other' })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists by run in index order with pagination and filters', async () => {
    const r = await run();
    for (let i = 0; i < 5; i++) {
      await sessions.upsert(t.db, makeSession(r, i, { status: i < 2 ? 'finished' : 'running' }));
    }
    const page1 = await sessions.listByRun(t.db, r.id, { limit: 2 });
    expect(page1.items.map((s) => s.index)).toEqual([0, 1]);
    const page2 = await sessions.listByRun(t.db, r.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((s) => s.index)).toEqual([2, 3]);
    const page3 = await sessions.listByRun(t.db, r.id, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((s) => s.index)).toEqual([4]);
    expect(page3.nextCursor).toBeUndefined();

    const control = await sessions.listByRun(t.db, r.id, { variant: 'control' });
    expect(control.items.map((s) => s.index)).toEqual([0, 2, 4]);
    const finished = await sessions.listByRun(t.db, r.id, { status: 'finished' });
    expect(finished.items.map((s) => s.index)).toEqual([0, 1]);
  });

  it('finish records the outcome, totals and judgement', async () => {
    const r = await run();
    const session = await sessions.upsert(t.db, makeSession(r, 0));
    const finished = await sessions.finish(t.db, session.id, {
      outcome: 'gave_up',
      outcomeReason: 'could not find pricing',
      steps: 7,
      costUsd: 0.03,
      inputTokens: 9000,
      outputTokens: 500,
      metrics: { activation: 0 },
      finishedAt: at(40),
    });
    expect(finished).toMatchObject({
      status: 'finished',
      outcome: 'gave_up',
      outcomeReason: 'could not find pricing',
      steps: 7,
      costUsd: 0.03,
      inputTokens: 9000,
      outputTokens: 500,
      metrics: { activation: 0 },
      finishedAt: at(40),
    });
    expect((await sessions.setJudgement(t.db, session.id, judgement)).judgement).toEqual(judgement);

    const other = await sessions.upsert(t.db, makeSession(r, 1));
    const failed = await sessions.finish(t.db, other.id, { error: 'browser crashed' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('browser crashed');
    expect(failed.finishedAt).toBeDefined();
    await expect(sessions.finish(t.db, 'ses_missing', {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

describeDb('steps', () => {
  const t = useTestDb();

  it('inserts in bulk and lists in index order', async () => {
    const env = await environments.create(t.db, { config });
    const r = await runs.create(t.db, makeRun(env.id));
    const session = await sessions.upsert(t.db, makeSession(r, 0));
    const items = [2, 0, 1].map((i) => makeStep(session, i));
    expect(await steps.insertMany(t.db, items)).toBe(3);
    expect(await steps.insertMany(t.db, [])).toBe(0);
    const listed = await steps.listBySession(t.db, session.id);
    expect(listed.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(listed).toEqual([0, 1, 2].map((i) => makeStep(session, i)));
    expect(await steps.get(t.db, listed[0]!.id)).toEqual(listed[0]);
    await expect(steps.get(t.db, 'stp_missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects duplicate (session, index) and unknown sessions', async () => {
    const env = await environments.create(t.db, { config });
    const r = await runs.create(t.db, makeRun(env.id));
    const session = await sessions.upsert(t.db, makeSession(r, 0));
    await steps.insertMany(t.db, [makeStep(session, 0)]);
    await expect(
      steps.insertMany(t.db, [makeStep(session, 0, { id: 'stp_other' })]),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      steps.insertMany(t.db, [makeStep({ ...session, id: 'ses_missing' }, 1)]),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await steps.listBySession(t.db, session.id)).toHaveLength(1);
  });

  it('splits large batches into chunks within one transaction', async () => {
    const env = await environments.create(t.db, { config });
    const r = await runs.create(t.db, makeRun(env.id));
    const session = await sessions.upsert(t.db, makeSession(r, 0));
    const many = Array.from({ length: 450 }, (_, i) => makeStep(session, i));
    expect(await steps.insertMany(t.db, many)).toBe(450);
    expect(await steps.listBySession(t.db, session.id)).toHaveLength(450);

    // A duplicate in the last chunk rolls back the whole batch.
    const other = await sessions.upsert(t.db, makeSession(r, 1));
    const withDuplicate = [
      ...Array.from({ length: 300 }, (_, i) => makeStep(other, i)),
      makeStep(other, 0, { id: 'stp_dup' }),
    ];
    await expect(steps.insertMany(t.db, withDuplicate)).rejects.toBeInstanceOf(ConflictError);
    expect(await steps.listBySession(t.db, other.id)).toHaveLength(0);
  });
});
