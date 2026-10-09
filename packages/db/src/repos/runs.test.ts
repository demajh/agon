import { ConflictError, NotFoundError, RunSchema } from '@agon/spec';
import { expect, it } from 'vitest';
import { environments, runs } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at, config, makeRun } from '../testing/fixtures.js';

describeDb('runs', () => {
  const t = useTestDb();

  async function env(): Promise<string> {
    return (await environments.create(t.db, { config })).id;
  }

  it('round-trips create -> get with defaults applied', async () => {
    const environmentId = await env();
    const created = await runs.create(t.db, {
      environmentId,
      variants: ['control', 'treatment'],
      seed: 7,
      config,
      createdAt: at(0),
    });
    expect(created.id).toMatch(/^run_[0-9a-z]{16}$/);
    expect(created).toEqual(
      RunSchema.parse({
        id: created.id,
        environmentId,
        status: 'queued',
        variants: ['control', 'treatment'],
        seed: 7,
        config,
        createdAt: at(0),
      }),
    );
    expect(created.counts).toEqual({
      planned: 0,
      running: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
    });
    expect(await runs.get(t.db, created.id)).toEqual(created);
    await expect(runs.get(t.db, 'run_missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(runs.create(t.db, makeRun('env_missing'))).rejects.toBeInstanceOf(NotFoundError);
    await expect(runs.create(t.db, { ...created })).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores large seeds exactly', async () => {
    const run = await runs.create(t.db, makeRun(await env(), { seed: 2 ** 48 + 3 }));
    expect((await runs.get(t.db, run.id)).seed).toBe(2 ** 48 + 3);
  });

  it('upserts a full run object', async () => {
    const run = makeRun(await env(), {
      status: 'running',
      startedAt: at(1),
      counts: { planned: 4, running: 2, completed: 1, failed: 1, interrupted: 0 },
      costUsd: 0.25,
    });
    expect(await runs.upsert(t.db, run)).toEqual(run);
    const finished = { ...run, status: 'completed' as const, finishedAt: at(9), error: 'none' };
    expect(await runs.upsert(t.db, finished)).toEqual(finished);
    expect(await runs.get(t.db, run.id)).toEqual(finished);
  });

  it('lists by environment newest first, paginated and filtered by status', async () => {
    const environmentId = await env();
    const other = await env();
    for (let i = 0; i < 5; i++) {
      await runs.create(t.db, {
        ...makeRun(environmentId, { createdAt: at(i), status: i === 2 ? 'failed' : 'queued' }),
        id: `run_${i}`,
      });
    }
    await runs.create(t.db, makeRun(other));

    const page1 = await runs.listByEnvironment(t.db, environmentId, { limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual(['run_4', 'run_3']);
    const page2 = await runs.listByEnvironment(t.db, environmentId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((r) => r.id)).toEqual(['run_2', 'run_1']);
    const page3 = await runs.listByEnvironment(t.db, environmentId, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((r) => r.id)).toEqual(['run_0']);
    expect(page3.nextCursor).toBeUndefined();

    const failed = await runs.listByEnvironment(t.db, environmentId, { status: 'failed' });
    expect(failed.items.map((r) => r.id)).toEqual(['run_2']);
  });

  it('setStatus stamps start and finish times unless given', async () => {
    const run = await runs.create(t.db, makeRun(await env()));
    const running = await runs.setStatus(t.db, run.id, 'running');
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeDefined();
    expect(running.finishedAt).toBeUndefined();
    const stillRunning = await runs.setStatus(t.db, run.id, 'running');
    expect(stillRunning.startedAt).toBe(running.startedAt);

    const failed = await runs.setStatus(t.db, run.id, 'failed', {
      finishedAt: at(5),
      error: 'budget exceeded',
    });
    expect(failed).toMatchObject({ status: 'failed', finishedAt: at(5), error: 'budget exceeded' });

    const cancelled = await runs.setStatus(t.db, run.id, 'cancelled');
    expect(Date.parse(cancelled.finishedAt ?? '')).toBeGreaterThan(Date.parse(at(5)));
    await expect(runs.setStatus(t.db, 'run_missing', 'running')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('bumpCounts adds atomically and never goes below zero', async () => {
    const run = await runs.create(t.db, makeRun(await env()));
    expect((await runs.bumpCounts(t.db, run.id, { planned: 4 })).counts.planned).toBe(4);
    await Promise.all(
      Array.from({ length: 10 }, () => runs.bumpCounts(t.db, run.id, { running: 1 })),
    );
    expect((await runs.get(t.db, run.id)).counts.running).toBe(10);
    const after = await runs.bumpCounts(t.db, run.id, { running: -1, completed: 1 });
    expect(after.counts).toEqual({
      planned: 4,
      running: 9,
      completed: 1,
      failed: 0,
      interrupted: 0,
    });
    expect((await runs.bumpCounts(t.db, run.id, { failed: -5 })).counts.failed).toBe(0);
    expect(await runs.bumpCounts(t.db, run.id, {})).toEqual(await runs.get(t.db, run.id));
  });

  it('addCost accumulates and setResult links the result', async () => {
    const run = await runs.create(t.db, makeRun(await env()));
    await runs.addCost(t.db, run.id, 0.25);
    expect((await runs.addCost(t.db, run.id, 0.5)).costUsd).toBe(0.75);
    expect((await runs.setResult(t.db, run.id, 'res_1')).resultId).toBe('res_1');
  });
});
