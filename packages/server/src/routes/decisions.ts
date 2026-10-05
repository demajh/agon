import { decisions } from '@agon/db';
import { createRoute } from '@hono/zod-openapi';
import type { AppContext } from '../context.js';
import {
  DecisionListQuerySchema,
  DecisionPageSchema,
  DecisionRef,
  IdParamSchema,
} from '../schemas.js';
import { approveDecision, rejectDecision } from '../squads/actions.js';
import {
  BEARER,
  COMMON_ERRORS,
  CONFLICT,
  NOT_FOUND,
  jsonContent,
  pageOptions,
  type App,
} from './shared.js';

const TAG = 'Decisions';

export const listDecisionsRoute = createRoute({
  method: 'get',
  path: '/v1/decisions',
  tags: [TAG],
  operationId: 'listDecisions',
  summary: 'List decisions',
  description: 'The append-only governance log, newest first.',
  security: BEARER,
  request: { query: DecisionListQuerySchema },
  responses: {
    200: jsonContent(DecisionPageSchema, 'Decisions'),
    ...COMMON_ERRORS,
  },
});

export const getDecisionRoute = createRoute({
  method: 'get',
  path: '/v1/decisions/{id}',
  tags: [TAG],
  operationId: 'getDecision',
  summary: 'Get a decision',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(DecisionRef, 'The decision'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
  },
});

export const approveDecisionRoute = createRoute({
  method: 'post',
  path: '/v1/decisions/{id}/approve',
  tags: [TAG],
  operationId: 'approveDecision',
  summary: 'Approve a proposed decision and execute it',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(DecisionRef, 'The decision after execution (`executed` or `failed`)'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
    ...CONFLICT,
  },
});

export const rejectDecisionRoute = createRoute({
  method: 'post',
  path: '/v1/decisions/{id}/reject',
  tags: [TAG],
  operationId: 'rejectDecision',
  summary: 'Reject a proposed decision',
  security: BEARER,
  request: { params: IdParamSchema },
  responses: {
    200: jsonContent(DecisionRef, 'The rejected decision'),
    ...COMMON_ERRORS,
    ...NOT_FOUND,
    ...CONFLICT,
  },
});

export function registerDecisionRoutes(app: App, ctx: AppContext): void {
  app.openapi(listDecisionsRoute, async (c) => {
    const query = c.req.valid('query');
    const page = await decisions.list(ctx.db, {
      ...pageOptions(query),
      ...(query.squadId === undefined ? {} : { squadId: query.squadId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.policyId === undefined ? {} : { policyId: query.policyId }),
      ...(query.actor === undefined ? {} : { actor: query.actor }),
    });
    return c.json(page, 200);
  });

  app.openapi(getDecisionRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await decisions.get(ctx.db, id), 200);
  });

  app.openapi(approveDecisionRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await approveDecision(ctx, id), 200);
  });

  app.openapi(rejectDecisionRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await rejectDecision(ctx, id), 200);
  });
}
