import { z } from 'zod';
import { SlugSchema } from './common.js';

export const SuccessCriterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), name: z.string().min(1) }),
  z.object({
    type: z.literal('url'),
    pattern: z.string().min(1).describe('Substring or glob matched against the current URL'),
  }),
  z.object({ type: z.literal('text'), contains: z.string().min(1) }),
  z.object({ type: z.literal('judge') }),
  z.object({
    type: z.literal('check'),
    command: z
      .string()
      .min(1)
      .describe(
        'Shell command run after the session; exit code 0 means success. Receives AGON_RUN_ID, AGON_SESSION_ID, AGON_VARIANT, AGON_VARIANT_URL, AGON_CREDENTIALS (JSON from the setup hook) and AGON_DECLARED_DONE.',
      ),
  }),
]);
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

const SUCCESS_SHORTHAND_RE = /^(event|url|text|check):(.+)$|^judge$/;

export function parseSuccessShorthand(value: string): SuccessCriterion {
  if (value === 'judge') return { type: 'judge' };
  const m = /^(event|url|text|check):(.+)$/.exec(value);
  if (!m) throw new Error(`invalid success criterion: ${value}`);
  const [, kind, rest] = m as unknown as [string, 'event' | 'url' | 'text' | 'check', string];
  switch (kind) {
    case 'event':
      return { type: 'event', name: rest };
    case 'url':
      return { type: 'url', pattern: rest };
    case 'text':
      return { type: 'text', contains: rest };
    case 'check':
      return { type: 'check', command: rest };
  }
}

/** Accepts `event:<name>`, `url:<pattern>`, `text:<needle>`, `check:<command>`, `judge`, or the object form. */
export const SuccessCriterionInputSchema = z
  .union([
    z
      .string()
      .regex(
        SUCCESS_SHORTHAND_RE,
        'use "event:<name>", "url:<pattern>", "text:<needle>", "check:<command>" or "judge"',
      )
      .describe(
        'Shorthand: "event:<name>", "url:<pattern>", "text:<needle>", "check:<command>" or "judge"',
      ),
    SuccessCriterionSchema,
  ])
  .transform((v): SuccessCriterion => (typeof v === 'string' ? parseSuccessShorthand(v) : v));

/** What the progress hash covers; see `scenarios[].stallSteps`. */
export const ProgressSignalSchema = z.enum(['observation', 'events', 'both']);
export type ProgressSignal = z.infer<typeof ProgressSignalSchema>;

export const ScenarioSchema = z.object({
  id: SlugSchema,
  goal: z.string().min(1).describe('What the user is trying to do, in their own words'),
  success: SuccessCriterionInputSchema,
  startPath: z.string().default('/'),
  maxSteps: z.number().int().positive().max(500).default(30),
  budgetUsd: z.number().positive().default(0.5),
  stallSteps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'End the session with outcome "stalled" once this many consecutive steps passed without the progress hash changing. Unset (the default) disables stall detection. About 60 suits edit-heavy tasks: on 820 real coding-agent sessions the gaps between writes had p50 6, p90 21, p95 32, p99 58, max 109, so 10 would end a quarter of real stretches. Leave it unset for pollers: a poller that correctly finds nothing new is not stuck.',
    ),
  progress: ProgressSignalSchema.default('observation').describe(
    'What the progress hash covers: "observation" hashes the adapter observation after each step (URL plus page text and controls for web, tool catalog plus last tool result for mcp), "events" counts the analytics events captured so far (intercepted rows and successful tool calls), "both" treats a change in either as progress. Every action or tool call is a step.',
  ),
  weight: z.number().positive().default(1),
  context: z
    .record(z.string(), z.string())
    .default({})
    .describe("Extra facts the user knows, e.g. a promo code or a colleague's referral"),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
