import { readFile } from 'node:fs/promises';
import { environments, events, results, runs, sessions, steps } from '@agon/db';
import {
  ConflictError,
  NotFoundError,
  RunRequestSchema,
  ValidationError,
  type AgonConfig,
} from '@agon/spec';
import { createRoute, z } from '@hono/zod-openapi';
import type { AppContext } from '../context.js';
import {
  IdParamSchema,
  ResultRef,
  RunListQuerySchema,
  RunPageSchema,
  RunRef,
  RunRequestRef,
  ScreenshotParamsSchema,
  SessionListQuerySchema,
  SessionPageSchema,
  SessionRef,
  TraceSchema,
} from '../schemas.js';
import { screenshotPath } from '../worker/recorders.js';
import { dataPaths } from '../worker/run-worker.js';
import {
  BEARER,
  COMMON_ERRORS,
  CONFLICT,
  NOT_FOUND,
  jsonContent,
  pageOptions,
  type App,
} from './shared.js';

const TAG = 'Runs';

export const startRunRoute = createRoute({
  method: 'post',
  path: '/v1/environments/{id}/runs',
  tags: [TAG],
  operationId: 'startRun',
  summary: 'Queue a run of an environment',
  description:
    'Creates the run (status `queued`) with a snapshot of the environment config and hands it to a worker. `variants` defaults to every variant; `size`, `seed` and `model` override the config.',
  security: BEARER,
  request: {
    params: IdParamSchema,
    body: {
      description: 'Run overrides (all optional)',
      content: { 'application/json': { schema: RunRequestRef } },
    },
  },
  responses: {
    201: jsonContent(RunRef, 'The queued run'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const listRunsRoute = createRoute({
  method: 'get',
  path: '/v1/environments/{id}/runs',
  tags: [TAG],
  operationId: 'listRuns',
  summary: 'List the runs of an environment',
  security: BEARER,
  request: { params: IdParamSchema, query: RunListQuerySchema },
  responses: {
    200: jsonContent(RunPageSchema, 'Runs, newest first'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const getRunRoute = createRoute({
  method: 'get',
  path: '/v1/runs/{id}',
  tags: [TAG],
  operationId: 'getRun',
  summary: 'Get a run',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(RunRef, 'The run'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const cancelRunRoute = createRoute({
  method: 'post',
  path: '/v1/runs/{id}/cancel',
  tags: [TAG],
  operationId: 'cancelRun',
  summary: 'Cancel a run',
  description:
    'A queued run is cancelled immediately. A running run is marked cancelled; the worker notices within a few seconds, finishes the sessions in flight and starts no new ones.',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(RunRef, 'The run, now cancelled'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
    ...CONFLICT,
  },
});

export const getResultRoute = createRoute({
  method: 'get',
  path: '/v1/runs/{id}/results',
  tags: [TAG],
  operationId: 'getRunResult',
  summary: 'Get the analysis of a run',
  description:
    'Returns 404 until the run has finished and its sessions were analyzed. Results are forecasts: show `calibration.note` next to every lift.',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(ResultRef, 'The result'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const listSessionsRoute = createRoute({
  method: 'get',
  path: '/v1/runs/{id}/sessions',
  tags: ['Sessions'],
  operationId: 'listSessions',
  summary: 'List the sessions of a run',
  security: BEARER,
  request: { params: IdParamSchema, query: SessionListQuerySchema },
  responses: {
    200: jsonContent(SessionPageSchema, 'Sessions in index order'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const getSessionRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}',
  tags: ['Sessions'],
  operationId: 'getSession',
  summary: 'Get a session',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(SessionRef, 'The session'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const getTraceRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}/trace',
  tags: ['Sessions'],
  operationId: 'getSessionTrace',
  summary: 'Get a session with its steps and events',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(TraceSchema, 'Session, steps in order, events in time order'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const getScreenshotRoute = createRoute({
  method: 'get',
  path: '/v1/runs/{id}/screenshots/{stepId}',
  tags: ['Sessions'],
  operationId: 'getScreenshot',
  summary: 'Get the screenshot taken at a step',
  security: BEARER,
  request: { params: ScreenshotParamsSchema },
  responses: {
    200: {
      description: 'PNG image',
      content: { 'image/png': { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

/** Applies the request overrides to the config snapshot a run is created from. */
export function snapshotConfig(
  config: AgonConfig,
  request: { size?: number | undefined; model?: string | undefined },
): AgonConfig {
  let out = config;
  if (request.size !== undefined)
    out = { ...out, population: { ...out.population, size: request.size } };
  if (request.model !== undefined)
    out = { ...out, defaults: { ...out.defaults, model: request.model } };
  return out;
}

export function registerRunRoutes(app: App, ctx: AppContext): void {
  app.openapi(startRunRoute, async (c) => {
    const { id } = c.req.valid('param');
    const request = RunRequestSchema.parse(c.req.valid('json') ?? {});
    const environment = await environments.get(ctx.db, id);
    const available = Object.keys(environment.config.target.variants);
    const chosen = request.variants ?? available;
    const unknown = chosen.filter((v) => !available.includes(v));
    if (unknown.length > 0) {
      throw new ValidationError(
        `unknown variants: ${unknown.join(', ')} (have: ${available.join(', ')})`,
        {
          unknown,
          available,
        },
      );
    }
    const config = snapshotConfig(environment.config, request);
    const run = await runs.create(ctx.db, {
      environmentId: environment.id,
      variants: chosen,
      seed: request.seed ?? config.population.seed,
      config,
      counts: { planned: config.population.size },
    });
    try {
      await ctx.queue.enqueueRun({ runId: run.id, ...(request.dryRun ? { dryRun: true } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await runs.setStatus(ctx.db, run.id, 'failed', { error: `could not enqueue: ${reason}` });
      throw error;
    }
    ctx.logger.info(
      { runId: run.id, environmentId: environment.id, variants: chosen },
      'run queued',
    );
    return c.json(run, 201);
  });

  app.openapi(listRunsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    await environments.get(ctx.db, id);
    const page = await runs.listByEnvironment(ctx.db, id, {
      ...pageOptions(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return c.json(page, 200);
  });

  app.openapi(getRunRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await runs.get(ctx.db, id), 200);
  });

  app.openapi(cancelRunRoute, async (c) => {
    const { id } = c.req.valid('param');
    const run = await runs.get(ctx.db, id);
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new ConflictError(`run ${id} is already ${run.status}`);
    }
    const cancelled = await runs.setStatus(ctx.db, id, 'cancelled', {
      error: run.status === 'running' ? 'cancellation requested' : 'cancelled before it started',
    });
    ctx.logger.info({ runId: id, was: run.status }, 'run cancelled');
    return c.json(cancelled, 200);
  });

  app.openapi(getResultRoute, async (c) => {
    const { id } = c.req.valid('param');
    await runs.get(ctx.db, id);
    const result = await results.findByRun(ctx.db, id);
    if (!result) throw new NotFoundError('result for run', id);
    return c.json(result, 200);
  });

  app.openapi(listSessionsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    await runs.get(ctx.db, id);
    const page = await sessions.listByRun(ctx.db, id, {
      ...pageOptions(query),
      ...(query.variant === undefined ? {} : { variant: query.variant }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return c.json(page, 200);
  });

  app.openapi(getSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await sessions.get(ctx.db, id), 200);
  });

  app.openapi(getTraceRoute, async (c) => {
    const { id } = c.req.valid('param');
    const session = await sessions.get(ctx.db, id);
    const [stepList, eventList] = await Promise.all([
      steps.listBySession(ctx.db, id),
      events.listBySession(ctx.db, id),
    ]);
    return c.json({ session, steps: stepList, events: eventList }, 200);
  });

  app.openapi(getScreenshotRoute, async (c) => {
    const { id, stepId } = c.req.valid('param');
    let path: string;
    try {
      path = screenshotPath(dataPaths(ctx.config.dataDir).screenshots, id, stepId);
    } catch {
      throw new NotFoundError('screenshot', `${id}/${stepId}`);
    }
    let png: Buffer;
    try {
      png = await readFile(path);
    } catch {
      throw new NotFoundError('screenshot', `${id}/${stepId}`);
    }
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
    });
  });
}
