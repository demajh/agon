import { OpenAPIHono } from '@hono/zod-openapi';
import { createAuthMiddleware, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';
import { createErrorHandler, notFoundHandler, validationError } from './errors.js';
import {
  DOCS_HTML,
  buildOpenApiDocument,
  docsRoute,
  openApiRoute,
  registerWebhookDocs,
} from './openapi.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerEnvironmentRoutes } from './routes/environments.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSquadRoutes } from './routes/squads.js';
import { registerVariantRoutes } from './routes/variants.js';

export type AgonApp = OpenAPIHono<AuthEnv>;

/** Builds the HTTP application: public meta routes, bearer auth for `/v1/*`, every resource. */
export function createApp(ctx: AppContext): AgonApp {
  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (result) => {
      if (!result.success) throw validationError(result.target, result.error);
    },
  });
  app.onError(createErrorHandler(ctx.logger));
  app.notFound(notFoundHandler);

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    ctx.logger.debug(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started },
      'request',
    );
  });

  registerWebhookDocs(app);
  registerHealthRoutes(app, ctx);
  let documentCache: Record<string, unknown> | undefined;
  app.openapi(openApiRoute, (c) => {
    documentCache ??= buildOpenApiDocument(app, ctx.version);
    return c.json(documentCache, 200);
  });
  app.openapi(docsRoute, (c) => c.html(DOCS_HTML, 200));

  app.use(
    '/v1/*',
    createAuthMiddleware({
      db: ctx.db,
      bootstrapKeys: ctx.config.bootstrapKeys,
      logger: ctx.logger,
    }),
  );
  registerEnvironmentRoutes(app, ctx);
  registerVariantRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerPersonaRoutes(app, ctx);
  registerSquadRoutes(app, ctx);
  registerDecisionRoutes(app, ctx);
  registerApiKeyRoutes(app, ctx);
  return app;
}
