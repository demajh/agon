import { squads } from '@agon/db';
import { testConfig } from '@agon/engine/fakes';
import { describe, expect, it } from 'vitest';
import { isAllowed, matchBootstrapKey, parseBootstrapKeys } from './index.js';
import { KEYS, describeDb, useTestServer } from './testing/harness.js';

describe('bootstrap keys', () => {
  it('parses key:role[:squad] lists', () => {
    expect(parseBootstrapKeys('abcdefghijklmnop:operator, qrstuvwxyz123456:squad:blue')).toEqual([
      { key: 'abcdefghijklmnop', role: 'operator' },
      { key: 'qrstuvwxyz123456', role: 'squad', squadSlug: 'blue' },
    ]);
    expect(parseBootstrapKeys(undefined)).toEqual([]);
    expect(parseBootstrapKeys('  ')).toEqual([]);
  });

  it('rejects short keys, unknown roles, squad keys without a slug and stray slugs', () => {
    expect(() => parseBootstrapKeys('short:operator')).toThrow(/16 characters/);
    expect(() => parseBootstrapKeys('abcdefghijklmnop:admin')).toThrow(/unknown role/);
    expect(() => parseBootstrapKeys('abcdefghijklmnop:squad')).toThrow(/squad slug/);
    expect(() => parseBootstrapKeys('abcdefghijklmnop:observer:blue')).toThrow(
      /cannot name a squad/,
    );
    expect(() => parseBootstrapKeys('abcdefghijklmnop:operator,abcdefghijklmnop:observer')).toThrow(
      /duplicate/,
    );
  });

  it('matches keys in constant time and by exact value', () => {
    const keys = parseBootstrapKeys('abcdefghijklmnop:operator');
    expect(matchBootstrapKey('abcdefghijklmnop', keys)?.role).toBe('operator');
    expect(matchBootstrapKey('abcdefghijklmnoq', keys)).toBeUndefined();
    expect(matchBootstrapKey('', keys)).toBeUndefined();
  });

  it('decides what each role may do', () => {
    const operator = { role: 'operator', source: 'bootstrap', label: 'op' } as const;
    const observer = { role: 'observer', source: 'bootstrap', label: 'obs' } as const;
    const squad = { role: 'squad', source: 'bootstrap', label: 'sq', squadSlug: 'blue' } as const;
    expect(isAllowed(observer, 'GET', '/v1/runs/run_1')).toBe(true);
    expect(isAllowed(observer, 'POST', '/v1/squads')).toBe(false);
    expect(isAllowed(operator, 'DELETE', '/v1/api-keys/key_1')).toBe(true);
    expect(isAllowed(squad, 'POST', '/v1/environments/env_1/variants')).toBe(true);
    expect(isAllowed(squad, 'POST', '/v1/environments/env_1/runs')).toBe(false);
    expect(isAllowed(squad, 'GET', '/v1/squads/leaderboard')).toBe(true);
  });
});

describeDb('authentication and roles over HTTP', () => {
  const h = useTestServer();

  it('serves /healthz, /openapi.json and /docs without a key', async () => {
    const health = await h.t.request('GET', '/healthz', { key: null });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, db: 'ok', role: 'all' });
    expect((await h.t.request('GET', '/openapi.json', { key: null })).status).toBe(200);
    const docs = await h.t.request('GET', '/docs', { key: null });
    expect(docs.status).toBe(200);
    expect(docs.response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('returns 401 without or with an unknown key', async () => {
    const missing = await h.t.request('GET', '/v1/environments', { key: null });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    });
    const unknown = await h.t.request('GET', '/v1/environments', {
      key: 'nope-nope-nope-nope-nope',
    });
    expect(unknown.status).toBe(401);
  });

  it('lets observers read but not write', async () => {
    expect((await h.t.request('GET', '/v1/environments', { key: KEYS.observer })).status).toBe(200);
    const denied = await h.t.request('POST', '/v1/environments', {
      key: KEYS.observer,
      body: { config: testConfig() },
    });
    expect(denied.status).toBe(403);
    expect((await denied.json<{ error: { code: string } }>()).error.code).toBe('forbidden');
  });

  it('restricts squad keys to reads and registering their own variants', async () => {
    expect((await h.t.request('GET', '/v1/squads', { key: KEYS.squadBlue })).status).toBe(200);
    expect(
      (
        await h.t.request('POST', '/v1/squads', {
          key: KEYS.squadBlue,
          body: { slug: 'x', name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.t.request('POST', '/v1/api-keys', {
          key: KEYS.squadBlue,
          body: { role: 'observer' },
        })
      ).status,
    ).toBe(403);
  });

  it('authenticates database keys, records their use, and stops once revoked', async () => {
    const created = await h.t.request('POST', '/v1/api-keys', {
      body: { role: 'observer', label: 'ci' },
    });
    expect(created.status).toBe(201);
    const { key, apiKey } = await created.json<{
      key: string;
      apiKey: { id: string; label: string };
    }>();
    expect(key).toMatch(/^agon_/);
    expect(apiKey.label).toBe('ci');
    expect(await created.json().then((b) => JSON.stringify(b))).not.toContain('keyHash');

    expect((await h.t.request('GET', '/v1/environments', { key })).status).toBe(200);
    expect(
      (await h.t.request('POST', '/v1/squads', { key, body: { slug: 'x', name: 'x' } })).status,
    ).toBe(403);

    const listed = await h.t.request('GET', '/v1/api-keys');
    const items = (await listed.json<{ items: { id: string; lastUsedAt?: string }[] }>()).items;
    expect(items.find((k) => k.id === apiKey.id)?.lastUsedAt).toBeDefined();

    const revoked = await h.t.request('DELETE', `/v1/api-keys/${apiKey.id}`);
    expect(revoked.status).toBe(200);
    expect((await revoked.json<{ revokedAt?: string }>()).revokedAt).toBeDefined();
    expect((await h.t.request('GET', '/v1/environments', { key })).status).toBe(401);
  });

  it('scopes database squad keys to their squad', async () => {
    const squad = await squads.create(h.t.server.db, { slug: 'green', name: 'Green' });
    const created = await h.t.request('POST', '/v1/api-keys', {
      body: { role: 'squad', squadId: squad.id },
    });
    expect(created.status).toBe(201);
    const { key } = await created.json<{ key: string }>();
    const env = await h.t.request('POST', '/v1/environments', { body: { config: testConfig() } });
    const envId = (await env.json<{ id: string }>()).id;
    const foreign = await h.t.request('POST', `/v1/environments/${envId}/variants`, {
      key,
      body: { name: 'v2', spec: { url: 'http://v2.test' }, squad: 'blue' },
    });
    expect(foreign.status).toBe(403);
    const own = await h.t.request('POST', `/v1/environments/${envId}/variants`, {
      key,
      body: { name: 'v2', spec: { url: 'http://v2.test' } },
    });
    expect(own.status).toBe(201);
    expect(await own.json()).toMatchObject({
      name: 'v2',
      squadId: squad.id,
      spec: { squad: 'green' },
    });
    const wrongSquadForKey = await h.t.request('POST', '/v1/api-keys', {
      body: { role: 'observer', squadId: squad.id },
    });
    expect(wrongSquadForKey.status).toBe(400);
  });

  it('answers unknown routes and bad JSON with the error envelope', async () => {
    const missing = await h.t.request('GET', '/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect((await missing.json<{ error: { code: string } }>()).error.code).toBe('not_found');
    const bad = await h.t.request('POST', '/v1/squads', {
      text: '{not json',
      contentType: 'application/json',
    });
    expect(bad.status).toBe(400);
    const invalid = await h.t.request('POST', '/v1/squads', {
      body: { slug: 'Not A Slug', name: '' },
    });
    expect(invalid.status).toBe(400);
    const body = await invalid.json<{ error: { code: string; details: { issues: unknown[] } } }>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });
});
