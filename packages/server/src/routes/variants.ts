import { environments, squads, variants } from '@agon/db';
import {
  AgonConfigSchema,
  ConfigError,
  ForbiddenError,
  NotFoundError,
  type AgonConfig,
} from '@agon/spec';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  IdParamSchema,
  RegisterVariantBodySchema,
  VariantListSchema,
  VariantRef,
} from '../schemas.js';
import { BEARER, COMMON_ERRORS, NOT_FOUND, jsonContent, type App } from './shared.js';

const TAG = 'Variants';

export const registerVariantRoute = createRoute({
  method: 'post',
  path: '/v1/environments/{id}/variants',
  tags: [TAG],
  operationId: 'registerVariant',
  summary: 'Register (or replace) a variant',
  description:
    'Upserts the variant and merges it into the environment config under `target.variants`, so the next run sees it. Squad keys may only register variants credited to their own squad.',
  security: BEARER,
  request: {
    params: IdParamSchema,
    body: {
      description: 'The variant',
      content: { 'application/json': { schema: RegisterVariantBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(VariantRef, 'The registered variant'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const listVariantsRoute = createRoute({
  method: 'get',
  path: '/v1/environments/{id}/variants',
  tags: [TAG],
  operationId: 'listVariants',
  summary: 'List the registered variants of an environment',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(VariantListSchema, 'Variants by name'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

/** The environment config with the variant merged into `target.variants`; validated as a whole. */
export function mergeVariant(
  config: AgonConfig,
  name: string,
  spec: AgonConfig['target']['variants'][string],
): AgonConfig {
  const parsed = AgonConfigSchema.safeParse({
    ...config,
    target: { ...config.target, variants: { ...config.target.variants, [name]: spec } },
  });
  if (!parsed.success) {
    throw new ConfigError(
      `variant "${name}" does not fit the environment config:\n${z.prettifyError(parsed.error)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function registerVariantRoutes(app: App, ctx: AppContext): void {
  app.openapi(registerVariantRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const principal = c.get('principal');
    const environment = await environments.get(ctx.db, id);

    let squadSlug = body.squad ?? body.spec.squad;
    if (principal.role === 'squad') {
      squadSlug ??= principal.squadSlug;
      if (squadSlug === undefined || squadSlug !== principal.squadSlug) {
        throw new ForbiddenError(
          `squad keys may only register variants for their own squad${principal.squadSlug ? ` (${principal.squadSlug})` : ''}`,
        );
      }
    }
    if (
      body.squad !== undefined &&
      body.spec.squad !== undefined &&
      body.squad !== body.spec.squad
    ) {
      throw new ConfigError(`squad "${body.squad}" and spec.squad "${body.spec.squad}" disagree`);
    }
    const squad = squadSlug === undefined ? undefined : await squads.findBySlug(ctx.db, squadSlug);
    if (squadSlug !== undefined && !squad) throw new NotFoundError('squad', squadSlug);

    const gitRef = body.gitRef ?? body.spec.gitRef;
    const spec = {
      ...body.spec,
      ...(squadSlug === undefined ? {} : { squad: squadSlug }),
      ...(gitRef === undefined ? {} : { gitRef }),
    };
    const config = mergeVariant(environment.config, body.name, spec);
    const variant = await variants.upsert(ctx.db, {
      environmentId: environment.id,
      name: body.name,
      spec,
      squadId: squad?.id ?? null,
      gitRef: gitRef ?? null,
    });
    await environments.update(ctx.db, environment.id, { config });
    ctx.logger.info(
      { environmentId: environment.id, variant: body.name, squad: squadSlug, by: principal.label },
      'variant registered',
    );
    return c.json(variant, 201);
  });

  app.openapi(listVariantsRoute, async (c) => {
    const { id } = c.req.valid('param');
    await environments.get(ctx.db, id);
    return c.json({ items: await variants.list(ctx.db, id) }, 200);
  });
}
