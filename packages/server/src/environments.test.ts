import { testConfig } from '@agon/engine/fakes';
import { AgonConfigSchema, type AgonConfig, type Environment } from '@agon/spec';
import { expect, it } from 'vitest';
import { describeDb, useTestServer } from './testing/harness.js';

const YAML = `
version: 1
name: yaml-env
target:
  kind: web
  variants:
    control: { url: http://control.test }
    treatment: { url: http://treatment.test, squad: blue }
population:
  size: 10
  personas: [{ use: builtin/smb-owner }]
scenarios:
  - { id: s1, goal: Try the product., success: event:project_created }
metrics:
  - { id: activation, type: conversion, event: project_created, primary: true }
`;

describeDb('environments', () => {
  const h = useTestServer();

  it('creates from JSON, reads back, lists, replaces and deletes', async () => {
    const config = testConfig();
    const created = await h.t.request('POST', '/v1/environments', { body: { config } });
    expect(created.status).toBe(201);
    const env = await created.json<Environment>();
    expect(env.id).toMatch(/^env_/);
    expect(env.name).toBe(config.name);
    expect(env.config).toEqual(config);

    const got = await h.t.request('GET', `/v1/environments/${env.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(env);

    const listed = await h.t.request('GET', '/v1/environments?limit=10');
    expect((await listed.json<{ items: Environment[] }>()).items.map((e) => e.id)).toEqual([
      env.id,
    ]);

    const renamed = await h.t.request('PUT', `/v1/environments/${env.id}`, {
      body: { name: 'renamed', config: { ...config, description: 'v2' } },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      id: env.id,
      name: 'renamed',
      config: { description: 'v2' },
    });

    expect((await h.t.request('DELETE', `/v1/environments/${env.id}`)).status).toBe(204);
    expect((await h.t.request('GET', `/v1/environments/${env.id}`)).status).toBe(404);
    expect((await h.t.request('DELETE', `/v1/environments/${env.id}`)).status).toBe(404);
  });

  it('creates from YAML text', async () => {
    const created = await h.t.request('POST', '/v1/environments', { text: YAML });
    expect(created.status).toBe(201);
    const env = await created.json<Environment>();
    expect(env.name).toBe('yaml-env');
    expect(env.config.target.variants['treatment']).toMatchObject({
      url: 'http://treatment.test',
      squad: 'blue',
    });
    expect(env.config.analysis.method).toBe('bayesian');

    const replaced = await h.t.request('PUT', `/v1/environments/${env.id}`, {
      text: YAML.replace('size: 10', 'size: 20'),
      contentType: 'text/yaml',
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json<Environment>()).config.population.size).toBe(20);
  });

  it('rejects unresolved ${...} placeholders without expanding them', async () => {
    const yaml = await h.t.request('POST', '/v1/environments', {
      text: YAML.replace('http://treatment.test', '${PREVIEW_URL}'),
    });
    expect(yaml.status).toBe(400);
    expect((await yaml.json<{ error: { message: string } }>()).error.message).toMatch(
      /client-side/,
    );

    const config = testConfig();
    const json = await h.t.request('POST', '/v1/environments', {
      body: { config: { ...config, description: 'built from ${GIT_SHA}' } },
    });
    expect(json.status).toBe(400);
    expect((await json.json<{ error: { details: { path: string } } }>()).error.details.path).toBe(
      'description',
    );
  });

  it('rejects invalid configs and policies it cannot evaluate', async () => {
    const invalid = await h.t.request('POST', '/v1/environments', {
      body: { config: { version: 1, name: 'x' } },
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json<{ error: { code: string } }>()).error.code).toBe('validation_error');

    const badYaml = await h.t.request('POST', '/v1/environments', { text: 'version: [1' });
    expect(badYaml.status).toBe(400);
    expect((await badYaml.json<{ error: { code: string } }>()).error.code).toBe('config_error');

    const config = testConfig({
      policies: [{ id: 'p', when: 'squad.unknown > 1', then: 'pause' }],
    });
    const badPolicy = await h.t.request('POST', '/v1/environments', { body: { config } });
    expect(badPolicy.status).toBe(400);
    expect((await badPolicy.json<{ error: { message: string } }>()).error.message).toMatch(
      /unknown variable/,
    );

    const unsupported = await h.t.request('POST', '/v1/environments', {
      text: 'x=1',
      contentType: 'text/csv',
    });
    expect(unsupported.status).toBe(415);
  });

  it('validates candidate configs without storing them', async () => {
    const created = await h.t.request('POST', '/v1/environments', {
      body: { config: testConfig() },
    });
    const env = await created.json<Environment>();

    const ok = await h.t.request('POST', `/v1/environments/${env.id}/validate`, {
      body: { config: testConfig() },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, issues: [] });

    const yamlOk = await h.t.request('POST', `/v1/environments/${env.id}/validate`, { text: YAML });
    expect(await yamlOk.json()).toEqual({ ok: true, issues: [] });

    const bad = await h.t.request('POST', `/v1/environments/${env.id}/validate`, {
      body: { config: { version: 1, name: 'x', scenarios: [] } },
    });
    expect(bad.status).toBe(200);
    const body = await bad.json<{ ok: boolean; issues: { path: string; message: string }[] }>();
    expect(body.ok).toBe(false);
    expect(body.issues.map((i) => i.path)).toContain('target');

    const placeholder = await h.t.request('POST', `/v1/environments/${env.id}/validate`, {
      text: YAML.replace('http://control.test', '${X}'),
    });
    expect((await placeholder.json<{ ok: boolean }>()).ok).toBe(false);

    expect(
      (await h.t.request('POST', '/v1/environments/env_missing/validate', { body: { config: {} } }))
        .status,
    ).toBe(404);
    expect((await h.t.request('GET', `/v1/environments/${env.id}`)).status).toBe(200);
  });

  it('paginates with cursors', async () => {
    const base: AgonConfig = testConfig();
    for (let i = 0; i < 3; i++) {
      await h.t.request('POST', '/v1/environments', {
        body: { config: AgonConfigSchema.parse({ ...base, name: `env-${i}` }) },
      });
    }
    const page1 = await h.t.request('GET', '/v1/environments?limit=2');
    const body1 = await page1.json<{ items: Environment[]; nextCursor?: string }>();
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).toBeDefined();
    const page2 = await h.t.request(
      'GET',
      `/v1/environments?limit=2&cursor=${encodeURIComponent(body1.nextCursor ?? '')}`,
    );
    const body2 = await page2.json<{ items: Environment[]; nextCursor?: string }>();
    expect(body2.items).toHaveLength(1);
    expect(body2.nextCursor).toBeUndefined();
    const names = [...body1.items, ...body2.items].map((e) => e.name).sort();
    expect(names).toEqual(['env-0', 'env-1', 'env-2']);
    expect((await h.t.request('GET', '/v1/environments?limit=0')).status).toBe(400);
  });
});
