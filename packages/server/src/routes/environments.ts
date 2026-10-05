import { environments } from '@agon/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { AppContext } from '../context.js';
import {
  CreateEnvironmentBodySchema,
  EnvironmentListQuerySchema,
  EnvironmentPageSchema,
  EnvironmentRef,
  IdParamSchema,
  ValidateConfigBodySchema,
  ValidateConfigResponseSchema,
} from '../schemas.js';
import {
  BEARER,
  COMMON_ERRORS,
  NOT_FOUND,
  jsonContent,
  pageOptions,
  readConfigBody,
  validateConfigBody,
  type App,
} from './shared.js';

const TAG = 'Environments';

const yamlBody = z.string().meta({ description: 'An agon.yaml document' });

const configRequestBody = (description: string) => ({
  description,
  content: {
    'application/json': { schema: CreateEnvironmentBodySchema },
    'application/yaml': { schema: yamlBody },
    'text/yaml': { schema: yamlBody },
  },
});

export const createEnvironmentRoute = createRoute({
  method: 'post',
  path: '/v1/environments',
  tags: [TAG],
  operationId: 'createEnvironment',
  summary: 'Create an environment',
  description:
    'Stores an agon.yaml as JSON (`{ name?, config }`) or as YAML text (`Content-Type: application/yaml`). Environment-variable placeholders (`${...}`) are not expanded server-side and are rejected.',
  security: BEARER,
  request: { body: configRequestBody('The config to store') },
  responses: {
    201: jsonContent(EnvironmentRef, 'The stored environment'),
    ...COMMON_ERRORS,
  },
});

export const listEnvironmentsRoute = createRoute({
  method: 'get',
  path: '/v1/environments',
  tags: [TAG],
  operationId: 'listEnvironments',
  summary: 'List environments',
  security: BEARER,
  request: { query: EnvironmentListQuerySchema },
  responses: {
    200: jsonContent(EnvironmentPageSchema, 'Environments, newest first'),
    ...COMMON_ERRORS,
  },
});

export const getEnvironmentRoute = createRoute({
  method: 'get',
  path: '/v1/environments/{id}',
  tags: [TAG],
  operationId: 'getEnvironment',
  summary: 'Get an environment',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(EnvironmentRef, 'The environment'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const replaceEnvironmentRoute = createRoute({
  method: 'put',
  path: '/v1/environments/{id}',
  tags: [TAG],
  operationId: 'replaceEnvironment',
  summary: 'Replace an environment config',
  security: BEARER,
  request: { params: IdParamSchema, body: configRequestBody('The new config') },
  responses: {
    200: jsonContent(EnvironmentRef, 'The updated environment'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const deleteEnvironmentRoute = createRoute({
  method: 'delete',
  path: '/v1/environments/{id}',
  tags: [TAG],
  operationId: 'deleteEnvironment',
  summary: 'Delete an environment and everything recorded under it',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    204: { description: 'Deleted' },
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const validateConfigRoute = createRoute({
  method: 'post',
  path: '/v1/environments/{id}/validate',
  tags: [TAG],
  operationId: 'validateConfig',
  summary: 'Validate a candidate config',
  description:
    'Checks a config (JSON `{ config }` or YAML text) against the agon.yaml schema and the policy expression grammar without storing it. The environment must exist.',
  security: BEARER,
  request: {
    params: IdParamSchema,
    body: {
      description: 'The candidate config',
      content: {
        'application/json': { schema: ValidateConfigBodySchema },
        'application/yaml': { schema: yamlBody },
        'text/yaml': { schema: yamlBody },
      },
    },
  },
  responses: {
    200: jsonContent(ValidateConfigResponseSchema, 'Whether the config is valid, with issues'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export function registerEnvironmentRoutes(app: App, ctx: AppContext): void {
  app.openapi(createEnvironmentRoute, async (c) => {
    const body = await readConfigBody(c, jsonOrUndefined(c.req.valid('json')));
    const created = await environments.create(ctx.db, {
      ...(body.name === undefined ? {} : { name: body.name }),
      config: body.config,
    });
    ctx.logger.info({ environmentId: created.id, name: created.name }, 'environment created');
    return c.json(created, 201);
  });

  app.openapi(listEnvironmentsRoute, async (c) => {
    const query = c.req.valid('query');
    const page = await environments.list(ctx.db, {
      ...pageOptions(query),
      ...(query.name === undefined ? {} : { name: query.name }),
    });
    return c.json(page, 200);
  });

  app.openapi(getEnvironmentRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await environments.get(ctx.db, id), 200);
  });

  app.openapi(replaceEnvironmentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = await readConfigBody(c, jsonOrUndefined(c.req.valid('json')));
    const updated = await environments.update(ctx.db, id, {
      config: body.config,
      ...(body.name === undefined ? {} : { name: body.name }),
    });
    return c.json(updated, 200);
  });

  app.openapi(deleteEnvironmentRoute, async (c) => {
    const { id } = c.req.valid('param');
    await environments.remove(ctx.db, id);
    ctx.logger.info({ environmentId: id }, 'environment deleted');
    return c.body(null, 204);
  });

  app.openapi(validateConfigRoute, async (c) => {
    const { id } = c.req.valid('param');
    await environments.get(ctx.db, id);
    return c.json(await validateConfigBody(c, jsonOrUndefined(c.req.valid('json'))), 200);
  });
}

/**
 * The validated JSON body, or undefined when the request carried YAML (the validator then leaves a
 * placeholder the handlers must not read as a config).
 */
function jsonOrUndefined<T>(value: T | string): T | undefined {
  return typeof value === 'string' ? undefined : value;
}
