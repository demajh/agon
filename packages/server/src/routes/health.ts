import { environments } from '@agon/db';
import { createRoute } from '@hono/zod-openapi';
import type { AppContext } from '../context.js';
import { HealthSchema } from '../schemas.js';
import { jsonContent, type App } from './shared.js';

export const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  tags: ['Meta'],
  operationId: 'health',
  summary: 'Liveness and database check (no auth)',
  security: [],
  responses: {
    200: jsonContent(HealthSchema, 'Healthy'),
    503: jsonContent(HealthSchema, 'The database is unreachable'),
  },
});

export function registerHealthRoutes(app: App, ctx: AppContext): void {
  app.openapi(healthRoute, async (c) => {
    let db: 'ok' | 'error' = 'ok';
    try {
      await environments.list(ctx.db, { limit: 1 });
    } catch (error) {
      ctx.logger.error({ err: error }, 'health check: database unreachable');
      db = 'error';
    }
    const body = { ok: db === 'ok', version: ctx.version, role: ctx.config.role, db };
    return db === 'ok' ? c.json(body, 200) : c.json(body, 503);
  });
}
