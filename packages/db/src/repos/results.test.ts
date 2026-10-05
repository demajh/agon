import { ConflictError, NotFoundError } from '@agon/spec';
import type { Run } from '@agon/spec';
import { expect, it } from 'vitest';
import { environments, results, runs } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { config, makeResult, makeRun } from '../testing/fixtures.js';

describeDb('results', () => {
  const t = useTestDb();

  async function run(): Promise<Run> {
    const env = await environments.create(t.db, { config });
    return runs.create(t.db, makeRun(env.id));
  }

  it('round-trips insert -> getByRun and allows one result per run', async () => {
    const r = await run();
    const result = makeResult(r);
    expect(await results.insert(t.db, result)).toEqual(result);
    expect(await results.getByRun(t.db, r.id)).toEqual(result);
    expect(await results.get(t.db, result.id)).toEqual(result);
    await expect(results.insert(t.db, makeResult(r))).rejects.toBeInstanceOf(ConflictError);
    await expect(
      results.insert(t.db, { ...makeResult(r), runId: 'run_missing' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('upsert replaces an earlier analysis of the same run', async () => {
    const r = await run();
    const first = await results.upsert(t.db, makeResult(r));
    const second = makeResult(r, { sessionsAnalyzed: 40 });
    expect(await results.upsert(t.db, second)).toEqual(second);
    expect(await results.getByRun(t.db, r.id)).toEqual(second);
    expect(await results.find(t.db, first.id)).toBeUndefined();
  });

  it('reports missing results', async () => {
    const r = await run();
    expect(await results.findByRun(t.db, r.id)).toBeUndefined();
    await expect(results.getByRun(t.db, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(results.get(t.db, 'res_missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
