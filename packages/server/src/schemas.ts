/**
 * Route schemas. Domain objects are the `@agon/spec` (and `@agon/db`) Zod schemas, registered as
 * OpenAPI components under stable names; only request/response wrappers are defined here.
 */
import { ApiKeyRoleSchema, ApiKeySchema, VariantSchema } from '@agon/db';
import {
  AgonConfigSchema,
  AgonEventSchema,
  DecisionSchema,
  DecisionStatusSchema,
  EnvironmentSchema,
  ErrorCodes,
  IdSchema,
  PersonaSchema,
  PolicyActionSchema,
  ResultSchema,
  RunRequestSchema,
  RunSchema,
  RunStatusSchema,
  SessionSchema,
  SessionStatusSchema,
  SlugSchema,
  SquadControlMessageSchema,
  SquadSchema,
  SquadScoreSchema,
  SquadStatusSchema,
  StepSchema,
  TicketSourceSchema,
  TimestampSchema,
  UnitSchema,
  VariantSpecSchema,
  type ErrorCode,
} from '@agon/spec';
import { z } from 'zod';

// --- registered domain components ------------------------------------------------------------

export const AgonConfigRef = AgonConfigSchema.meta({
  id: 'AgonConfig',
  description: 'An agon.yaml document: what to simulate.',
});
export const EnvironmentRef = EnvironmentSchema.omit({ config: true })
  .extend({ config: AgonConfigRef })
  .meta({ id: 'Environment' });
export const VariantSpecRef = VariantSpecSchema.meta({ id: 'VariantSpec' });
export const VariantRef = VariantSchema.omit({ spec: true })
  .extend({ spec: VariantSpecRef })
  .meta({ id: 'Variant' });
export const RunRequestRef = RunRequestSchema.meta({ id: 'RunRequest' });
export const RunRef = RunSchema.omit({ config: true }).extend({ config: AgonConfigRef }).meta({
  id: 'Run',
  description: '`config` is the snapshot of the environment config at run time.',
});
export const SessionRef = SessionSchema.meta({ id: 'Session' });
export const StepRef = StepSchema.meta({ id: 'Step' });
export const AgonEventRef = AgonEventSchema.meta({ id: 'AgonEvent' });
export const ResultRef = ResultSchema.meta({ id: 'Result' });
export const SquadRef = SquadSchema.meta({ id: 'Squad' });
export const SquadControlMessageRef = SquadControlMessageSchema.meta({
  id: 'SquadControlMessage',
  description: 'Squad Control Protocol: the body Agon POSTs to a squad controlUrl.',
});
export const DecisionRef = DecisionSchema.meta({ id: 'Decision' });
export const PersonaRef = PersonaSchema.meta({ id: 'Persona' });
export const TicketSourceRef = TicketSourceSchema.meta({ id: 'TicketSource' });

/** An API key as returned by the API: the stored hash is never exposed. */
export const ApiKeyPublicSchema = ApiKeySchema.omit({ keyHash: true }).meta({ id: 'ApiKey' });
export type ApiKeyPublic = z.infer<typeof ApiKeyPublicSchema>;

// --- errors --------------------------------------------------------------------------------------

const ERROR_CODES = Object.values(ErrorCodes) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorResponse' });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// --- pagination ---------------------------------------------------------------------------------

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
});

export function pageOf<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().optional().describe('Pass back as `cursor` to fetch the next page'),
    })
    .meta({ id });
}

export const IdParamSchema = z.object({ id: IdSchema });

// --- health ---------------------------------------------------------------------------------------

export const HealthSchema = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    role: z.enum(['all', 'api', 'worker']),
    db: z.enum(['ok', 'error']),
  })
  .meta({ id: 'Health' });

// --- environments ---------------------------------------------------------------------------------

export const CreateEnvironmentBodySchema = z
  .object({
    name: SlugSchema.optional().describe('Defaults to config.name'),
    config: AgonConfigRef,
  })
  .meta({ id: 'CreateEnvironmentBody' });

export const ValidateConfigBodySchema = z
  .object({ config: z.unknown().describe('A candidate agon.yaml document as JSON') })
  .meta({ id: 'ValidateConfigBody' });

export const ValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export const ValidateConfigResponseSchema = z
  .object({ ok: z.boolean(), issues: z.array(ValidationIssueSchema) })
  .meta({ id: 'ValidateConfigResponse' });
export type ValidateConfigResponse = z.infer<typeof ValidateConfigResponseSchema>;

export const EnvironmentListQuerySchema = PaginationQuerySchema.extend({
  name: SlugSchema.optional(),
});

export const EnvironmentPageSchema = pageOf(EnvironmentRef, 'EnvironmentPage');

// --- variants -------------------------------------------------------------------------------------

export const RegisterVariantBodySchema = z
  .object({
    name: SlugSchema,
    spec: VariantSpecRef,
    squad: SlugSchema.optional().describe('Squad credited with this variant'),
    gitRef: z.string().optional(),
  })
  .meta({ id: 'RegisterVariantBody' });

export const VariantListSchema = z
  .object({ items: z.array(VariantRef) })
  .meta({ id: 'VariantList' });

// --- runs -----------------------------------------------------------------------------------------

export const RunListQuerySchema = PaginationQuerySchema.extend({
  status: RunStatusSchema.optional(),
});
export const RunPageSchema = pageOf(RunRef, 'RunPage');

export const SessionListQuerySchema = PaginationQuerySchema.extend({
  variant: SlugSchema.optional(),
  status: SessionStatusSchema.optional(),
});
export const SessionPageSchema = pageOf(SessionRef, 'SessionPage');

export const TraceSchema = z
  .object({
    session: SessionRef,
    steps: z.array(StepRef),
    events: z.array(AgonEventRef),
  })
  .meta({ id: 'Trace' });

export const ScreenshotParamsSchema = z.object({ id: IdSchema, stepId: IdSchema });

// --- personas -------------------------------------------------------------------------------------

export const PersonaListSchema = z
  .object({ items: z.array(PersonaRef) })
  .meta({ id: 'PersonaList' });

// --- squads ---------------------------------------------------------------------------------------

export const CreateSquadBodySchema = z
  .object({
    slug: SlugSchema,
    name: z.string().min(1),
    controlUrl: z.url().optional(),
    ticketSource: TicketSourceRef.optional(),
  })
  .meta({ id: 'CreateSquadBody' });

export const UpdateSquadBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    controlUrl: z.url().nullable().optional().describe('null clears the control webhook'),
    ticketSource: TicketSourceRef.nullable().optional(),
  })
  .meta({ id: 'UpdateSquadBody' });

export const SquadListQuerySchema = z.object({ status: SquadStatusSchema.optional() });
export const SquadListSchema = z.object({ items: z.array(SquadRef) }).meta({ id: 'SquadList' });

export const LeaderboardEntrySchema = z
  .object({
    rank: z.number().int().positive(),
    squadId: IdSchema,
    slug: SlugSchema,
    name: z.string(),
    status: SquadStatusSchema,
    allocation: UnitSchema,
    score: SquadScoreSchema,
  })
  .meta({ id: 'LeaderboardEntry' });
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardSchema = z
  .object({ items: z.array(LeaderboardEntrySchema), computedAt: TimestampSchema })
  .meta({ id: 'Leaderboard' });

export const SquadActionBodySchema = z
  .object({
    reason: z.string().min(1),
    approval: z
      .enum(['auto', 'human'])
      .optional()
      .describe(
        '"auto" (default) records an approved decision and executes it now; "human" only proposes it, to be approved through POST /v1/decisions/{id}/approve',
      ),
  })
  .meta({ id: 'SquadActionBody' });

export const SquadActionResponseSchema = z
  .object({ squad: SquadRef, decision: DecisionRef })
  .meta({ id: 'SquadActionResponse' });

export const ReallocateBodySchema = z
  .object({
    floor: UnitSchema.optional().describe('Minimum share every active squad keeps (default 0.1)'),
    reason: z.string().min(1).optional(),
    seed: z.number().int().nonnegative().optional(),
  })
  .meta({ id: 'ReallocateBody' });

export const ReallocateResponseSchema = z
  .object({
    decision: DecisionRef,
    allocation: z.record(SlugSchema, UnitSchema),
    squads: z.array(SquadRef),
  })
  .meta({ id: 'ReallocateResponse' });

// --- decisions ------------------------------------------------------------------------------------

export const DecisionListQuerySchema = PaginationQuerySchema.extend({
  squadId: IdSchema.optional(),
  status: DecisionStatusSchema.optional(),
  kind: PolicyActionSchema.optional(),
  policyId: SlugSchema.optional(),
  actor: z.enum(['auto', 'human']).optional(),
});
export const DecisionPageSchema = pageOf(DecisionRef, 'DecisionPage');

// --- api keys -------------------------------------------------------------------------------------

export const CreateApiKeyBodySchema = z
  .object({
    role: ApiKeyRoleSchema,
    label: z.string().optional(),
    squadId: IdSchema.optional().describe('Required for squad keys'),
  })
  .meta({ id: 'CreateApiKeyBody' });

export const CreatedApiKeySchema = z
  .object({
    key: z.string().describe('The secret. Shown once; only its hash is stored.'),
    apiKey: ApiKeyPublicSchema,
  })
  .meta({ id: 'CreatedApiKey' });

export const ApiKeyListSchema = z
  .object({ items: z.array(ApiKeyPublicSchema) })
  .meta({ id: 'ApiKeyList' });

// --- outbound webhooks ----------------------------------------------------------------------------

export const WEBHOOK_EVENTS = [
  'run.completed',
  'result.ready',
  'decision.proposed',
  'decision.made',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WebhookEnvelopeSchema = z
  .object({
    event: z.enum(WEBHOOK_EVENTS),
    timestamp: TimestampSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'WebhookEnvelope', description: 'Body of every outbound webhook Agon sends.' });
export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;
