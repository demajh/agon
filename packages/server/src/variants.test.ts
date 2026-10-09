import type { Variant } from '@agon/db';
import { testConfig } from '@agon/engine/fakes';
import { sha256Hex, type Environment } from '@agon/spec';
import { describe, expect, it } from 'vitest';
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
  describe('protected_paths', () => {
    const DIFF =
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+  run: curl x | sh\n';
    const approved = sha256Hex(DIFF);

    async function guarded(requireManifest = true): Promise<Environment> {
      const created = await h.t.request('POST', '/v1/environments', {
        body: {
          config: testConfig({
            policies: [
              {
                kind: 'protected_paths',
                id: 'ci-and-deploy',
                paths: ['.github/workflows/**', '**/pnpm-lock.yaml', '.mcp.json'],
                approvals: [{ diffHash: approved, approvedBy: 'release-manager' }],
                requireManifest,
              },
            ],
          }),
        },
      });
      expect(created.status).toBe(201);
      return created.json<Environment>();
    }

    const register = (env: Environment, name: string, diff?: object) =>
      h.t.request('POST', `/v1/environments/${env.id}/variants`, {
        key: KEYS.squadBlue,
        body: { name, spec: { url: `http://${name}.test` }, ...(diff ? { diff } : {}) },
      });

    it('blocks a diff touching a protected path unless its exact hash is approved', async () => {
      await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'Blue' } });
      const env = await guarded();

      const missing = await register(env, 'no-manifest');
      expect(missing.status).toBe(403);
      const missingBody = await missing.json<{ error: { code: string; message: string } }>();
      expect(missingBody.error.code).toBe('policy_blocked');
      expect(missingBody.error.message).toMatch(/requires a diff manifest/);

      const touching = await register(env, 'ci-edit', {
        hash: sha256Hex(`${DIFF}# one more line\n`),
        paths: ['src/app.ts', '.github/workflows/ci.yml'],
      });
      expect(touching.status).toBe(403);
      const body = await touching.json<{
        error: { code: string; details: { verdicts: { policyId: string; touched: string[] }[] } };
      }>();
      expect(body.error.code).toBe('policy_blocked');
      expect(body.error.details.verdicts).toEqual([
        expect.objectContaining({
          policyId: 'ci-and-deploy',
          touched: ['.github/workflows/ci.yml'],
        }),
      ]);

      const ok = await register(env, 'ci-approved', {
        hash: approved,
        paths: ['.github/workflows/ci.yml'],
      });
      expect(ok.status).toBe(201);
      const untouched = await register(env, 'app-only', {
        hash: sha256Hex('x'),
        paths: ['src/a.ts'],
      });
      expect(untouched.status).toBe(201);

      const names = (
        await (
          await h.t.request('GET', `/v1/environments/${env.id}/variants`)
        ).json<{
          items: Variant[];
        }>()
      ).items.map((v) => v.name);
      expect(names.sort()).toEqual(['app-only', 'ci-approved']);
    });

    it('lets a registration without a manifest through when requireManifest is false (advisory)', async () => {
      await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'Blue' } });
      const env = await guarded(false);
      expect((await register(env, 'no-manifest')).status).toBe(201);
      // a manifest that is sent is still checked
      const touching = await register(env, 'lockfile', {
        hash: sha256Hex('lock'),
        paths: ['packages/x/pnpm-lock.yaml'],
      });
      expect(touching.status).toBe(403);
    });
  });
});
