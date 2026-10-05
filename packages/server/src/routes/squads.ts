import { squads } from '@agon/db';
import { nowIso, type Squad } from '@agon/spec';
import { createRoute } from '@hono/zod-openapi';
import type { AppContext } from '../context.js';
import {
  CreateSquadBodySchema,
  IdParamSchema,
  LeaderboardSchema,
  ReallocateBodySchema,
  ReallocateResponseSchema,
  SquadActionBodySchema,
  SquadActionResponseSchema,
  SquadListQuerySchema,
  SquadListSchema,
  SquadRef,
  UpdateSquadBodySchema,
  type LeaderboardEntry,
} from '../schemas.js';
import { actOnSquad, reallocate } from '../squads/actions.js';
import type { SquadAction } from '../squads/executor.js';
import { BEARER, COMMON_ERRORS, CONFLICT, NOT_FOUND, jsonContent, type App } from './shared.js';

const TAG = 'Squads';

export const createSquadRoute = createRoute({
  method: 'post',
  path: '/v1/squads',
  tags: [TAG],
  operationId: 'createSquad',
  summary: 'Register a squad',
  security: BEARER,
  request: {
    body: {
      description: 'The squad',
      content: { 'application/json': { schema: CreateSquadBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(SquadRef, 'The squad'),
    ...COMMON_ERRORS,
    ...CONFLICT,
  },
});

export const listSquadsRoute = createRoute({
  method: 'get',
  path: '/v1/squads',
  tags: [TAG],
  operationId: 'listSquads',
  summary: 'List squads',
  security: BEARER,
  request: { query: SquadListQuerySchema },
  responses: {
    200: jsonContent(SquadListSchema, 'Squads, oldest first'),
    ...COMMON_ERRORS,
  },
});

export const leaderboardRoute = createRoute({
  method: 'get',
  path: '/v1/squads/leaderboard',
  tags: [TAG],
  operationId: 'getLeaderboard',
  summary: 'Squad leaderboard',
  description:
    'Squads ranked by win rate, then mean calibrated lift, with their current allocation.',
  security: BEARER,
  responses: {
    200: jsonContent(LeaderboardSchema, 'Ranked squads'),
    ...COMMON_ERRORS,
  },
});

export const reallocateRoute = createRoute({
  method: 'post',
  path: '/v1/squads/reallocate',
  tags: [TAG],
  operationId: 'reallocateSquads',
  summary: 'Reallocate work across active squads',
  description:
    "Thompson-sampling allocation from each active squad's wins and runs, with a floor every squad keeps. Records one `reallocate` Decision, updates every allocation, and notifies control webhooks.",
  security: BEARER,
  request: {
    body: {
      description: 'Allocation parameters',
      content: { 'application/json': { schema: ReallocateBodySchema } },
    },
  },
  responses: {
    200: jsonContent(ReallocateResponseSchema, 'The decision and the new allocation'),
    ...COMMON_ERRORS,
    ...CONFLICT,
  },
});

export const getSquadRoute = createRoute({
  method: 'get',
  path: '/v1/squads/{id}',
  tags: [TAG],
  operationId: 'getSquad',
  summary: 'Get a squad',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(SquadRef, 'The squad'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const updateSquadRoute = createRoute({
  method: 'patch',
  path: '/v1/squads/{id}',
  tags: [TAG],
  operationId: 'updateSquad',
  summary: "Update a squad's name, control webhook or ticket source",
  security: BEARER,
  request: {
    params: IdParamSchema,
    body: {
      description: 'Fields to change',
      content: { 'application/json': { schema: UpdateSquadBodySchema } },
      required: true,
    },
  },
  responses: {
    200: jsonContent(SquadRef, 'The updated squad'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

const actionRoute = (action: SquadAction, summary: string) =>
  createRoute({
    method: 'post',
    path: `/v1/squads/{id}/${action}`,
    tags: [TAG],
    operationId: `${action}Squad`,
    summary,
    description: `Writes a Decision (kind \`${action}\`, actor human) first, then sets the squad status and POSTs a SquadControlMessage to the squad's controlUrl. Webhook failures are recorded on the decision (status \`failed\`), never returned as errors.`,
    security: BEARER,
    request: {
      params: IdParamSchema,
      body: {
        description: 'Why',
        content: { 'application/json': { schema: SquadActionBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonContent(SquadActionResponseSchema, 'The squad and the decision that changed it'),
      ...COMMON_ERRORS,
      ...NOT_FOUND,
      ...CONFLICT,
    },
  });

export const pauseSquadRoute = actionRoute('pause', 'Pause a squad');
export const resumeSquadRoute = actionRoute('resume', 'Resume a paused squad');
export const killSquadRoute = actionRoute('kill', 'Kill a squad');

/** Ranks squads by win rate, then mean lift, then runs; ties broken by slug for stability. */
export function rankSquads(list: readonly Squad[]): LeaderboardEntry[] {
  return [...list]
    .sort(
      (a, b) =>
        b.score.winRate - a.score.winRate ||
        b.score.meanLift - a.score.meanLift ||
        b.score.runs - a.score.runs ||
        a.slug.localeCompare(b.slug),
    )
    .map((squad, i) => ({
      rank: i + 1,
      squadId: squad.id,
      slug: squad.slug,
      name: squad.name,
      status: squad.status,
      allocation: squad.allocation,
      score: squad.score,
    }));
}

export function registerSquadRoutes(app: App, ctx: AppContext): void {
  app.openapi(createSquadRoute, async (c) => {
    const body = c.req.valid('json');
    const squad = await squads.create(ctx.db, {
      slug: body.slug,
      name: body.name,
      ...(body.controlUrl === undefined ? {} : { controlUrl: body.controlUrl }),
      ...(body.ticketSource === undefined ? {} : { ticketSource: body.ticketSource }),
    });
    ctx.logger.info({ squadId: squad.id, slug: squad.slug }, 'squad created');
    return c.json(squad, 201);
  });

  app.openapi(listSquadsRoute, async (c) => {
    const query = c.req.valid('query');
    const items = await squads.list(
      ctx.db,
      query.status === undefined ? {} : { status: query.status },
    );
    return c.json({ items }, 200);
  });

  // Static paths before `/v1/squads/{id}` so they are matched first.
  app.openapi(leaderboardRoute, async (c) =>
    c.json({ items: rankSquads(await squads.list(ctx.db)), computedAt: nowIso() }, 200),
  );

  app.openapi(reallocateRoute, async (c) => {
    const body = c.req.valid('json') ?? {};
    const outcome = await reallocate(ctx, {
      floor: body.floor,
      seed: body.seed,
      reason: body.reason,
      actor: 'human',
    });
    return c.json(outcome, 200);
  });

  app.openapi(getSquadRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await squads.get(ctx.db, id), 200);
  });

  app.openapi(updateSquadRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const updated = await squads.update(ctx.db, id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.controlUrl === undefined ? {} : { controlUrl: body.controlUrl }),
      ...(body.ticketSource === undefined ? {} : { ticketSource: body.ticketSource }),
    });
    return c.json(updated, 200);
  });

  for (const [route, action] of [
    [pauseSquadRoute, 'pause'],
    [resumeSquadRoute, 'resume'],
    [killSquadRoute, 'kill'],
  ] as const) {
    app.openapi(route, async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const outcome = await actOnSquad(ctx, id, action, {
        reason: body.reason,
        approval: body.approval,
        actor: 'human',
      });
      return c.json(outcome, 200);
    });
  }
}
