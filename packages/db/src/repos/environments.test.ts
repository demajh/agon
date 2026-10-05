import { ConflictError, EnvironmentSchema, NotFoundError } from '@agon/spec';
import { expect, it } from 'vitest';
import { environments, runs, variants } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at, config, makeRun } from '../testing/fixtures.js';

describeDb('environments', () => {
  const t = useTestDb();

  it('round-trips create -> get and defaults the name to the config name', async () => {
    const created = await environments.create(t.db, { config, createdAt: at(0) });
    expect(created.id).toMatch(/^env_[0-9a-z]{16}$/);
    expect(created).toEqual(
      EnvironmentSchema.parse({
        id: created.id,
        name: config.name,
        config,
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    expect(await environments.get(t.db, created.id)).toEqual(created);
    expect(await environments.find(t.db, 'env_missing')).toBeUndefined();
    await expect(environments.get(t.db, 'env_missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a duplicate id with ConflictError', async () => {
    await environments.create(t.db, { id: 'env_dup', config });
    await expect(environments.create(t.db, { id: 'env_dup', config })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('lists newest first with cursor pagination and a name filter', async () => {
    for (let i = 0; i < 5; i++) {
      await environments.create(t.db, {
        id: `env_${i}`,
        name: i % 2 === 0 ? 'even' : 'odd',
        config,
        createdAt: at(i),
      });
    }
    const page1 = await environments.list(t.db, { limit: 2 });
    expect(page1.items.map((e) => e.id)).toEqual(['env_4', 'env_3']);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await environments.list(t.db, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((e) => e.id)).toEqual(['env_2', 'env_1']);
    const page3 = await environments.list(t.db, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((e) => e.id)).toEqual(['env_0']);
    expect(page3.nextCursor).toBeUndefined();

    const even = await environments.list(t.db, { name: 'even' });
    expect(even.items.map((e) => e.id)).toEqual(['env_4', 'env_2', 'env_0']);
  });

  it('updates name and config and bumps updatedAt', async () => {
    const created = await environments.create(t.db, { config, createdAt: at(0) });
    const renamed = { ...config, name: 'renamed' };
    const updated = await environments.update(t.db, created.id, {
      name: 'renamed',
      config: renamed,
    });
    expect(updated.name).toBe('renamed');
    expect(updated.config).toEqual(renamed);
    expect(updated.createdAt).toBe(at(0));
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(at(0)));
    await expect(environments.update(t.db, 'env_missing', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('deletes an environment together with its variants and runs', async () => {
    const env = await environments.create(t.db, { config });
    await variants.upsert(t.db, {
      environmentId: env.id,
      name: 'control',
      spec: config.target.variants['control']!,
    });
    const run = await runs.create(t.db, makeRun(env.id));
    await environments.delete(t.db, env.id);
    expect(await environments.find(t.db, env.id)).toBeUndefined();
    expect(await variants.list(t.db, env.id)).toEqual([]);
    expect(await runs.find(t.db, run.id)).toBeUndefined();
    await expect(environments.remove(t.db, env.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
