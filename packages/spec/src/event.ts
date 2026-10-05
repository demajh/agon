import { z } from 'zod';
import { IdSchema, ModelRefSchema, SlugSchema, TimestampSchema } from './common.js';
import { ValidationError } from './errors.js';
import { AnalyticsProviderSchema } from './target.js';

/** Properties every event Agon emits must carry so simulated data can never pass for real traffic. */
export const SimPropertiesSchema = z.object({
  agon_simulated: z.literal(true),
  agon_run_id: IdSchema,
  agon_session_id: IdSchema,
  agon_variant: SlugSchema,
  agon_persona: SlugSchema,
  agon_model: ModelRefSchema,
  agon_scenario: SlugSchema.optional(),
});
export type SimProperties = z.infer<typeof SimPropertiesSchema>;

export const SIM_PROPERTY_KEYS = Object.keys(SimPropertiesSchema.shape) as (keyof SimProperties)[];

export const EventSourceSchema = z.enum(['intercepted', 'inferred', 'judge']);
export type EventSource = z.infer<typeof EventSourceSchema>;

/** An event produced by an adapter before the engine stamps identities onto it. */
export const EventDraftSchema = z.object({
  timestamp: TimestampSchema,
  event: z.string().min(1),
  source: EventSourceSchema,
  provider: AnalyticsProviderSchema.optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type EventDraft = z.infer<typeof EventDraftSchema>;

export const AgonEventSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    sessionId: IdSchema,
    timestamp: TimestampSchema,
    event: z.string().min(1),
    distinctId: z.string().min(1),
    source: EventSourceSchema,
    provider: AnalyticsProviderSchema.optional(),
    properties: z.record(z.string(), z.unknown()),
  })
  .superRefine((e, ctx) => {
    const parsed = SimPropertiesSchema.safeParse(e.properties);
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['properties'],
        message: `event is missing simulation markers: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      });
    }
  });
export type AgonEvent = z.infer<typeof AgonEventSchema>;

export interface SimContext {
  runId: string;
  sessionId: string;
  variant: string;
  personaId: string;
  model: string;
  scenarioId?: string;
}

export function simProperties(ctx: SimContext): SimProperties {
  return {
    agon_simulated: true,
    agon_run_id: ctx.runId,
    agon_session_id: ctx.sessionId,
    agon_variant: ctx.variant,
    agon_persona: ctx.personaId,
    agon_model: ctx.model,
    ...(ctx.scenarioId === undefined ? {} : { agon_scenario: ctx.scenarioId }),
  };
}

/** Throws unless the event carries every simulation marker. Exporters call this before sending. */
export function assertSimulated(event: AgonEvent): void {
  const parsed = SimPropertiesSchema.safeParse(event.properties);
  if (!parsed.success) {
    throw new ValidationError(
      `refusing to export event "${event.event}" without simulation markers`,
      parsed.error.issues,
    );
  }
}

/** Events the engine itself infers from what the adapter sees. */
export const INFERRED_EVENTS = {
  sessionStart: '$agon_session_start',
  sessionEnd: '$agon_session_end',
  pageview: '$pageview',
  click: '$agon_click',
  formSubmit: '$agon_form_submit',
  error: '$agon_error',
  abandon: '$agon_abandon',
  success: '$agon_success',
  toolCall: '$agon_tool_call',
  toolError: '$agon_tool_error',
} as const;
export type InferredEventName = (typeof INFERRED_EVENTS)[keyof typeof INFERRED_EVENTS];
