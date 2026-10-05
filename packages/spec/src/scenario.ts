import { z } from 'zod';
import { SlugSchema } from './common.js';

export const SuccessCriterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), name: z.string().min(1) }),
  z.object({ type: z.literal('url'), pattern: z.string().min(1).describe('Substring or glob matched against the current URL') }),
  z.object({ type: z.literal('text'), contains: z.string().min(1) }),
  z.object({ type: z.literal('judge') }),
]);
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

const SUCCESS_SHORTHAND_RE = /^(event|url|text):(.+)$|^judge$/;

export function parseSuccessShorthand(value: string): SuccessCriterion {
  if (value === 'judge') return { type: 'judge' };
  const m = /^(event|url|text):(.+)$/.exec(value);
  if (!m) throw new Error(`invalid success criterion: ${value}`);
  const [, kind, rest] = m as unknown as [string, 'event' | 'url' | 'text', string];
  switch (kind) {
    case 'event':
      return { type: 'event', name: rest };
    case 'url':
      return { type: 'url', pattern: rest };
    case 'text':
      return { type: 'text', contains: rest };
  }
}

/** Accepts `event:<name>`, `url:<pattern>`, `text:<needle>`, `judge`, or the object form. */
export const SuccessCriterionInputSchema = z
  .union([
    z
      .string()
      .regex(SUCCESS_SHORTHAND_RE, 'use "event:<name>", "url:<pattern>", "text:<needle>" or "judge"')
      .describe('Shorthand: "event:<name>", "url:<pattern>", "text:<needle>" or "judge"'),
    SuccessCriterionSchema,
  ])
  .transform((v): SuccessCriterion => (typeof v === 'string' ? parseSuccessShorthand(v) : v));

export const ScenarioSchema = z.object({
  id: SlugSchema,
  goal: z.string().min(1).describe('What the user is trying to do, in their own words'),
  success: SuccessCriterionInputSchema,
  startPath: z.string().default('/'),
  maxSteps: z.number().int().positive().max(500).default(30),
  budgetUsd: z.number().positive().default(0.5),
  weight: z.number().positive().default(1),
  context: z
    .record(z.string(), z.string())
    .default({})
    .describe('Extra facts the user knows, e.g. a promo code or a colleague\'s referral'),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
