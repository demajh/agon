import { apiKeys, squads, type ApiKey } from '@agon/db';
import { createRoute } from '@hono/zod-openapi';
import { assertOperator } from '../auth.js';
import type { AppContext } from '../context.js';
import {
  ApiKeyListSchema,
  ApiKeyPublicSchema,
  CreateApiKeyBodySchema,
  CreatedApiKeySchema,
  IdParamSchema,
  type ApiKeyPublic,
} from '../schemas.js';
import { BEARER, COMMON_ERRORS, NOT_FOUND, jsonContent, type App } from './shared.js';

const TAG = 'API keys';

export const createApiKeyRoute = createRoute({
  method: 'post',
  path: '/v1/api-keys',
  tags: [TAG],
  operationId: 'createApiKey',
  summary: 'Create an API key (operators only)',
  description: 'The plaintext key is returned once and never stored; only its hash is.',
  security: BEARER,
  request: {
    body: {
      description: 'Role and scope',
      content: { 'application/json': { schema: CreateApiKeyBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(CreatedApiKeySchema, 'The key and its record'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const listApiKeysRoute = createRoute({
  method: 'get',
  path: '/v1/api-keys',
  tags: [TAG],
  operationId: 'listApiKeys',
  summary: 'List active API keys (operators only)',
  security: BEARER,
  responses: {
    200: jsonContent(ApiKeyListSchema, 'Keys, oldest first; hashes are never returned'),
    ...COMMON_ERRORS,
  },
});

export const revokeApiKeyRoute = createRoute({
  method: 'delete',
  path: '/v1/api-keys/{id}',
  tags: [TAG],
  operationId: 'revokeApiKey',
  summary: 'Revoke an API key (operators only)',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(ApiKeyPublicSchema, 'The revoked key record'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export function toPublic(key: ApiKey): ApiKeyPublic {
  const { keyHash: _hash, ...rest } = key;
  return rest;
}

export function registerApiKeyRoutes(app: App, ctx: AppContext): void {
  app.openapi(createApiKeyRoute, async (c) => {
    assertOperator(c.get('principal'));
    const body = c.req.valid('json');
    if (body.squadId !== undefined) await squads.get(ctx.db, body.squadId);
    const created = await apiKeys.create(ctx.db, {
      role: body.role,
      label: body.label ?? `${body.role} key`,
      ...(body.squadId === undefined ? {} : { squadId: body.squadId }),
    });
    ctx.logger.info({ keyId: created.apiKey.id, role: body.role }, 'api key created');
    return c.json({ key: created.key, apiKey: toPublic(created.apiKey) }, 201);
  });

  app.openapi(listApiKeysRoute, async (c) => {
    assertOperator(c.get('principal'));
    const items = (await apiKeys.list(ctx.db)).map(toPublic);
    return c.json({ items }, 200);
  });

  app.openapi(revokeApiKeyRoute, async (c) => {
    assertOperator(c.get('principal'));
    const { id } = c.req.valid('param');
    const revoked = await apiKeys.revoke(ctx.db, id);
    ctx.logger.info({ keyId: id }, 'api key revoked');
    return c.json(toPublic(revoked), 200);
  });
}
