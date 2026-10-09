import { z } from 'zod';
import { IdSchema, ModelRefSchema, SlugSchema, TimestampSchema, UnitSchema } from './common.js';
import { PersonaInstanceSchema } from './persona.js';

export const InteractiveElementSchema = z.object({
  ref: z.string().min(1).describe('Stable handle the agent uses to act on this element'),
  role: z.string().min(1),
  name: z.string().default(''),
  value: z.string().optional(),
  href: z.string().optional(),
  disabled: z.boolean().default(false),
  checked: z.boolean().optional(),
});
export type InteractiveElement = z.infer<typeof InteractiveElementSchema>;

/** What the simulated user perceives at one step, after persona-dependent pruning. */
export const ObservationSchema = z.object({
  url: z.string(),
  title: z.string().default(''),
  text: z.string().describe("Readable page content, already truncated to the persona's attention"),
  interactive: z.array(InteractiveElementSchema),
  errors: z.array(z.string()).default([]),
  truncated: z.boolean().default(false),
  hash: z
    .string()
    .min(1)
    .describe('Content hash used to detect repeated states and to cache decisions'),
  screenshotRef: z.string().optional(),
  capturedAt: TimestampSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ref: z.string().min(1) }),
  z.object({ type: z.literal('fill'), ref: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('select'), ref: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('press'), key: z.string().min(1) }),
  z.object({ type: z.literal('navigate'), url: z.string().min(1) }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['down', 'up']) }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('wait'), ms: z.number().int().positive().max(10_000) }),
  z.object({
    type: z.literal('tool_call'),
    ref: z.string().min(1).describe('Ref of a tool listed in the observation'),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ type: z.literal('give_up'), reason: z.string().min(1) }),
  z.object({ type: z.literal('done'), reason: z.string().min(1) }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  navigated: z.boolean().default(false),
});
export type ActResult = z.infer<typeof ActResultSchema>;

export const FeelingSchema = z.enum(['confident', 'neutral', 'confused', 'frustrated']);
export type Feeling = z.infer<typeof FeelingSchema>;

export const ProgressSchema = z.enum(['progress', 'none', 'regress']);
export type Progress = z.infer<typeof ProgressSchema>;

/** The structured output the simulated-user agent produces at every step. */
export const DecisionTraceSchema = z.object({
  perception: z.string().describe('What this user notices on the page, in their voice'),
  thinking: z.string().describe('Why they do what they do next'),
  feeling: FeelingSchema,
  progress: ProgressSchema.describe('Did the last action move them toward the goal?'),
  action: ActionSchema,
});
export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

export const LlmUsageSchema = z.object({
  model: ModelRefSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  cached: z.boolean().default(false),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const StepSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  index: z.number().int().nonnegative(),
  observation: ObservationSchema,
  decision: DecisionTraceSchema,
  result: ActResultSchema,
  patience: UnitSchema.describe('Remaining patience after this step'),
  usage: LlmUsageSchema,
  startedAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),
});
export type Step = z.infer<typeof StepSchema>;

export const SessionStatusSchema = z.enum(['pending', 'running', 'finished', 'failed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionOutcomeSchema = z.enum([
  'success',
  'gave_up',
  'max_steps',
  'budget_exceeded',
  'error',
  'stalled',
]);
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;

/** Independent post-hoc assessment of a session by a judge model. */
export const JudgementSchema = z.object({
  success: z.boolean(),
  satisfaction: z.number().int().min(1).max(5),
  frustration: z.number().int().min(1).max(5),
  confidence: UnitSchema,
  summary: z.string(),
  usage: LlmUsageSchema.optional(),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const SessionSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  index: z.number().int().nonnegative(),
  variant: SlugSchema,
  scenarioId: SlugSchema,
  persona: PersonaInstanceSchema,
  status: SessionStatusSchema,
  outcome: SessionOutcomeSchema.optional(),
  outcomeReason: z.string().optional(),
  steps: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  metrics: z
    .record(z.string(), z.number())
    .default({})
    .describe('Metric values computed for this session'),
  judgement: JudgementSchema.optional(),
  maxStepsSinceProgress: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Longest run of consecutive steps whose progress hash did not change'),
  lastProgressStep: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Steps taken when progress was last observed; 0 when never'),
  progressSteps: z
    .array(z.number().int().positive())
    .optional()
    .describe('Step counts after which progress was observed, in order'),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  error: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;
