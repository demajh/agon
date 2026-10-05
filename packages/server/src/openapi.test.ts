import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeDb, useTestServer } from './testing/harness.js';

const EXPECTED_ROUTES: [string, string][] = [
  ['get', '/healthz'],
  ['get', '/openapi.json'],
  ['get', '/docs'],
  ['post', '/v1/environments'],
  ['get', '/v1/environments'],
  ['get', '/v1/environments/{id}'],
  ['put', '/v1/environments/{id}'],
  ['delete', '/v1/environments/{id}'],
  ['post', '/v1/environments/{id}/validate'],
  ['post', '/v1/environments/{id}/variants'],
  ['get', '/v1/environments/{id}/variants'],
  ['post', '/v1/environments/{id}/runs'],
  ['get', '/v1/environments/{id}/runs'],
  ['get', '/v1/runs/{id}'],
  ['post', '/v1/runs/{id}/cancel'],
  ['get', '/v1/runs/{id}/results'],
  ['get', '/v1/runs/{id}/sessions'],
  ['get', '/v1/runs/{id}/screenshots/{stepId}'],
  ['get', '/v1/sessions/{id}'],
  ['get', '/v1/sessions/{id}/trace'],
  ['get', '/v1/personas'],
  ['post', '/v1/squads'],
  ['get', '/v1/squads'],
  ['get', '/v1/squads/leaderboard'],
  ['post', '/v1/squads/reallocate'],
  ['get', '/v1/squads/{id}'],
  ['patch', '/v1/squads/{id}'],
  ['post', '/v1/squads/{id}/pause'],
  ['post', '/v1/squads/{id}/resume'],
  ['post', '/v1/squads/{id}/kill'],
  ['get', '/v1/decisions'],
  ['get', '/v1/decisions/{id}'],
  ['post', '/v1/decisions/{id}/approve'],
  ['post', '/v1/decisions/{id}/reject'],
  ['post', '/v1/api-keys'],
  ['get', '/v1/api-keys'],
  ['delete', '/v1/api-keys/{id}'],
];

const EXPECTED_SCHEMAS = [
  'AgonConfig',
  'Environment',
  'Variant',
  'VariantSpec',
  'Run',
  'RunRequest',
  'Session',
  'Step',
  'AgonEvent',
  'Result',
  'Squad',
  'SquadControlMessage',
  'Decision',
  'Persona',
  'ApiKey',
  'ErrorResponse',
  'WebhookEnvelope',
];

interface Operation {
  operationId?: string;
  responses: Record<string, { description?: string; content?: Record<string, unknown> }>;
  parameters?: { name: string; in: string; required?: boolean }[];
  security?: unknown[];
  tags?: string[];
}

interface Document {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  webhooks: Record<string, Record<string, Operation>>;
  security: unknown[];
}

describeDb('GET /openapi.json', () => {
  const h = useTestServer();

  it('is an OpenAPI 3.1 document describing every route', async () => {
    const response = await h.t.request('GET', '/openapi.json', { key: null });
    expect(response.status).toBe(200);
    const doc = await response.json<Document>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Agon API');
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });

    for (const [method, path] of EXPECTED_ROUTES) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(op!.operationId, `${method} ${path} operationId`).toBeTruthy();
      expect(Object.keys(op!.responses).length, `${method} ${path} responses`).toBeGreaterThan(0);
      for (const [status, res] of Object.entries(op!.responses)) {
        expect(status).toMatch(/^[1-5]\d\d$/);
        expect(res.description, `${method} ${path} ${status} description`).toBeTruthy();
      }
      const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const name of params) {
        expect(
          op!.parameters?.some((p) => p.in === 'path' && p.name === name && p.required),
          `${path} declares {${name}}`,
        ).toBe(true);
      }
      if (path.startsWith('/v1/')) {
        for (const status of ['401', '403']) {
          expect(op!.responses[status], `${method} ${path} documents ${status}`).toBeDefined();
        }
      } else {
        expect(op!.security).toEqual([]);
      }
    }
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m} ${path}`),
    );
    expect(documented.sort()).toEqual(EXPECTED_ROUTES.map(([m, p]) => `${m} ${p}`).sort());

    for (const name of EXPECTED_SCHEMAS) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
    const run = doc.components.schemas['Run'] as { properties: { config: unknown } };
    expect(run.properties.config).toEqual({ $ref: '#/components/schemas/AgonConfig' });
    expect(Object.keys(doc.webhooks).sort()).toEqual(['agonEvent', 'squadControl']);
    expect(JSON.stringify(doc)).not.toContain('"$ref":"#/components/schemas/undefined"');
    expect(JSON.stringify(doc)).not.toContain('keyHash');
  });

  it('is stable across calls and matches the committed packages/sdk/openapi.json', async () => {
    const a = await (await h.t.request('GET', '/openapi.json', { key: null })).text();
    const b = await (await h.t.request('GET', '/openapi.json', { key: null })).text();
    expect(a).toBe(b);
    const committed = JSON.parse(
      readFileSync(new URL('../../sdk/openapi.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(JSON.parse(a)).toEqual(committed);
  });
});

describe('docs page', () => {
  it('points the API reference at /openapi.json', async () => {
    const { DOCS_HTML } = await import('./openapi.js');
    expect(DOCS_HTML).toContain('data-url="/openapi.json"');
  });
});
