import { createRequire } from 'node:module';
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { AuthEnv } from './auth.js';
import { SquadControlMessageRef, WebhookEnvelopeSchema } from './schemas.js';

/** The server's own version, from package.json. */
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version?: string };
  return pkg.version ?? '0.0.0';
}

export const openApiRoute = createRoute({
  method: 'get',
  path: '/openapi.json',
  tags: ['Meta'],
  operationId: 'getOpenApiDocument',
  summary: 'This API as an OpenAPI 3.1 document (no auth)',
  security: [],
  responses: {
    200: {
      description: 'The OpenAPI document',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
  },
});

export const docsRoute = createRoute({
  method: 'get',
  path: '/docs',
  tags: ['Meta'],
  operationId: 'getDocs',
  summary: 'Interactive API reference (no auth)',
  security: [],
  responses: {
    200: {
      description: 'An HTML page rendering /openapi.json',
      content: { 'text/html': { schema: z.string() } },
    },
  },
});

/** Documents the messages Agon sends out, so clients can generate types for them too. */
export function registerWebhookDocs(app: OpenAPIHono<AuthEnv>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'API key from AGON_API_KEYS or POST /v1/api-keys',
  });
  app.openAPIRegistry.registerWebhook({
    method: 'post',
    path: 'squadControl',
    summary: 'Squad Control Protocol',
    description:
      "POSTed to a squad's controlUrl when a pause, resume, kill or reallocate decision executes.",
    tags: ['Webhooks'],
    request: {
      body: {
        description: 'The control message',
        content: { 'application/json': { schema: SquadControlMessageRef } },
      },
    },
    responses: { 200: { description: 'Any 2xx acknowledges the message' } },
  });
  app.openAPIRegistry.registerWebhook({
    method: 'post',
    path: 'agonEvent',
    summary: 'Outbound event webhook',
    description:
      'POSTed to AGON_WEBHOOK_URL for run.completed, result.ready, decision.proposed and decision.made.',
    tags: ['Webhooks'],
    request: {
      body: {
        description: 'The event envelope',
        content: { 'application/json': { schema: WebhookEnvelopeSchema } },
      },
    },
    responses: { 200: { description: 'Any 2xx acknowledges the event' } },
  });
}

function sortKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) as T;
}

/** Builds the OpenAPI 3.1 document for an app; paths and components are sorted for stable output. */
export function buildOpenApiDocument(
  app: OpenAPIHono<AuthEnv>,
  version: string,
): Record<string, unknown> {
  const document = app.getOpenAPI31Document(
    {
      openapi: '3.1.0',
      info: {
        title: 'Agon API',
        version,
        description:
          'Control plane for simulated-user experiments and squad governance. Every lift or P(best) is a forecast; show the calibration note next to it.',
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'Meta' },
        { name: 'Environments' },
        { name: 'Variants' },
        { name: 'Runs' },
        { name: 'Sessions' },
        { name: 'Personas' },
        { name: 'Squads' },
        { name: 'Decisions' },
        { name: 'API keys' },
        { name: 'Webhooks' },
      ],
    },
    { sortComponents: 'alphabetically', unionPreferredType: 'oneOf' },
  ) as unknown as Record<string, unknown> & {
    paths?: Record<string, unknown>;
    webhooks?: Record<string, unknown>;
  };
  return {
    ...document,
    ...(document.paths ? { paths: sortKeys(document.paths) } : {}),
    ...(document.webhooks ? { webhooks: sortKeys(document.webhooks) } : {}),
  };
}

export const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agon API</title>
  </head>
  <body>
    <noscript>Enable JavaScript to browse the API, or read <a href="/openapi.json">/openapi.json</a>.</noscript>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;
