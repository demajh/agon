import { ConflictError, NotFoundError, VariantSpecSchema } from '@agon/spec';
import { expect, it } from 'vitest';
import { VariantSchema, environments, squads, variants } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at, config } from '../testing/fixtures.js';

const controlSpec = VariantSpecSchema.parse({ url: 'https://app.example.com', gitRef: 'main' });
const treatmentSpec = VariantSpecSchema.parse({
  url: 'https://pr-123.example.app',
  squad: 'squad-blue',
  description: 'shorter onboarding',
});

describeDb('variants', () => {
  const t = useTestDb();

  it('round-trips upsert -> get with a deterministic id', async () => {
    const env = await environments.create(t.db, { id: 'env_abc', config });
    const created = await variants.upsert(t.db, {
      environmentId: env.id,
      name: 'control',
      spec: controlSpec,
      createdAt: at(0),
    });
    expect(created.id).toBe('var_abc_control');
    expect(created).toEqual(
      VariantSchema.parse({
        id: 'var_abc_control',
        environmentId: env.id,
        name: 'control',
        spec: controlSpec,
        gitRef: 'main',
        createdAt: at(0),
        updatedAt: created.updatedAt,
      }),
    );
    expect(await variants.get(t.db, env.id, 'control')).toEqual(created);
    expect(await variants.getById(t.db, created.id)).toEqual(created);
    expect(await variants.find(t.db, env.id, 'nope')).toBeUndefined();
    await expect(variants.get(t.db, env.id, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('replaces the spec on re-registration and keeps id and createdAt', async () => {
    const env = await environments.create(t.db, { config });
    const first = await variants.upsert(t.db, {
      environmentId: env.id,
      name: 'treatment',
      spec: treatmentSpec,
      createdAt: at(0),
    });
    const second = await variants.upsert(t.db, {
      environmentId: env.id,
      name: 'treatment',
      spec: { ...treatmentSpec, url: 'https://pr-124.example.app' },
      gitRef: 'abc123',
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(at(0));
    expect(second.spec.url).toBe('https://pr-124.example.app');
    expect(second.gitRef).toBe('abc123');
    expect(await variants.list(t.db, env.id)).toEqual([second]);
  });

  it('credits a squad, keeps it when omitted and clears it on null', async () => {
    const env = await environments.create(t.db, { config });
    const squad = await squads.create(t.db, { slug: 'squad-blue', name: 'Blue' });
    const base = { environmentId: env.id, name: 'treatment', spec: treatmentSpec };
    expect((await variants.upsert(t.db, { ...base, squadId: squad.id })).squadId).toBe(squad.id);
    expect((await variants.upsert(t.db, base)).squadId).toBe(squad.id);
    expect((await variants.upsert(t.db, { ...base, squadId: null })).squadId).toBeUndefined();
    await expect(variants.upsert(t.db, { ...base, squadId: 'sqd_missing' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('lists by name and rejects unknown environments and clashing ids', async () => {
    const env = await environments.create(t.db, { config });
    await variants.upsert(t.db, { environmentId: env.id, name: 'treatment', spec: treatmentSpec });
    await variants.upsert(t.db, { environmentId: env.id, name: 'control', spec: controlSpec });
    expect((await variants.list(t.db, env.id)).map((v) => v.name)).toEqual([
      'control',
      'treatment',
    ]);

    await expect(
      variants.upsert(t.db, { environmentId: 'env_missing', name: 'control', spec: controlSpec }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      variants.upsert(t.db, {
        id: 'var_clash',
        environmentId: env.id,
        name: 'other',
        spec: controlSpec,
      }),
    ).resolves.toBeDefined();
    await expect(
      variants.upsert(t.db, {
        id: 'var_clash',
        environmentId: env.id,
        name: 'another',
        spec: controlSpec,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('removes a variant', async () => {
    const env = await environments.create(t.db, { config });
    await variants.upsert(t.db, { environmentId: env.id, name: 'control', spec: controlSpec });
    await variants.delete(t.db, env.id, 'control');
    expect(await variants.list(t.db, env.id)).toEqual([]);
    await expect(variants.remove(t.db, env.id, 'control')).rejects.toBeInstanceOf(NotFoundError);
  });
});
