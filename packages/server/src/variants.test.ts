import type { Variant } from '@agon/db';
import { testConfig } from '@agon/engine/fakes';
import type { Environment } from '@agon/spec';
import { expect, it } from 'vitest';
import { KEYS, describeDb, useTestServer } from './testing/harness.js';

describeDb('variants', () => {
  const h = useTestServer();

  async function environment(): Promise<Environment> {
    const created = await h.t.request('POST', '/v1/environments', {
      body: { config: testConfig() },
    });
    return created.json<Environment>();
  }

  it('registers a variant and merges it into the environment config', async () => {
    const env = await environment();
    await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'Blue' } });
    const registered = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      body: {
        name: 'pr-42',
        spec: { url: 'https://pr-42.preview.test', description: 'PR 42' },
        squad: 'blue',
        gitRef: 'abc123',
      },
    });
    expect(registered.status).toBe(201);
    const variant = await registered.json<Variant>();
    expect(variant).toMatchObject({
      environmentId: env.id,
      name: 'pr-42',
      gitRef: 'abc123',
      spec: { url: 'https://pr-42.preview.test', squad: 'blue', gitRef: 'abc123' },
    });
    expect(variant.squadId).toMatch(/^sqd_/);

    const updated = await (
      await h.t.request('GET', `/v1/environments/${env.id}`)
    ).json<Environment>();
    expect(Object.keys(updated.config.target.variants).sort()).toEqual([
      'control',
      'pr-42',
      'treatment',
    ]);
    expect(updated.config.target.variants['pr-42']).toMatchObject({
      url: 'https://pr-42.preview.test',
      squad: 'blue',
    });

    const listed = await h.t.request('GET', `/v1/environments/${env.id}/variants`);
    expect((await listed.json<{ items: Variant[] }>()).items.map((v) => v.name)).toEqual(['pr-42']);

    // Registering again replaces the spec (idempotent id) and the config entry.
    const again = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      body: { name: 'pr-42', spec: { url: 'https://pr-42-b.preview.test' }, squad: 'blue' },
    });
    expect(again.status).toBe(201);
    expect((await again.json<Variant>()).id).toBe(variant.id);
    const after = await (
      await h.t.request('GET', `/v1/environments/${env.id}`)
    ).json<Environment>();
    expect(after.config.target.variants['pr-42']?.url).toBe('https://pr-42-b.preview.test');
    expect((await h.t.request('GET', `/v1/environments/${env.id}/variants`)).status).toBe(200);
  });

  it('rejects variants the config cannot accept and unknown squads', async () => {
    const env = await environment();
    const noUrl = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      body: { name: 'broken', spec: { description: 'no url for a web target' } },
    });
    expect(noUrl.status).toBe(400);
    expect((await noUrl.json<{ error: { code: string } }>()).error.code).toBe('config_error');
    const unknownSquad = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      body: { name: 'v', spec: { url: 'http://v.test' }, squad: 'nobody' },
    });
    expect(unknownSquad.status).toBe(404);
    expect(
      (
        await h.t.request('POST', '/v1/environments/env_missing/variants', {
          body: { name: 'v', spec: { url: 'http://v.test' } },
        })
      ).status,
    ).toBe(404);
    const unchanged = await (
      await h.t.request('GET', `/v1/environments/${env.id}`)
    ).json<Environment>();
    expect(Object.keys(unchanged.config.target.variants).sort()).toEqual(['control', 'treatment']);
  });

  it('lets squad keys register only for their own squad, defaulting the attribution', async () => {
    const env = await environment();
    await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'Blue' } });
    await h.t.request('POST', '/v1/squads', { body: { slug: 'red', name: 'Red' } });

    const other = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      key: KEYS.squadBlue,
      body: { name: 'sneaky', spec: { url: 'http://sneaky.test' }, squad: 'red' },
    });
    expect(other.status).toBe(403);
    const viaSpec = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      key: KEYS.squadBlue,
      body: { name: 'sneaky', spec: { url: 'http://sneaky.test', squad: 'red' } },
    });
    expect(viaSpec.status).toBe(403);

    const own = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      key: KEYS.squadBlue,
      body: { name: 'blue-1', spec: { url: 'http://blue-1.test' } },
    });
    expect(own.status).toBe(201);
    expect((await own.json<Variant>()).spec.squad).toBe('blue');

    const explicit = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      key: KEYS.squadBlue,
      body: { name: 'blue-2', spec: { url: 'http://blue-2.test' }, squad: 'blue' },
    });
    expect(explicit.status).toBe(201);

    const asOperator = await h.t.request('POST', `/v1/environments/${env.id}/variants`, {
      body: { name: 'red-1', spec: { url: 'http://red-1.test' }, squad: 'red' },
    });
    expect(asOperator.status).toBe(201);
    const listed = await (
      await h.t.request('GET', `/v1/environments/${env.id}/variants`, { key: KEYS.observer })
    ).json<{ items: Variant[] }>();
    expect(listed.items.map((v) => v.name)).toEqual(['blue-1', 'blue-2', 'red-1']);
  });
});
