import { z } from 'zod';
import { ModelRefSchema, SlugSchema, UnitSchema } from './common.js';

export const ProficiencySchema = z.enum(['novice', 'intermediate', 'expert']);
export type Proficiency = z.infer<typeof ProficiencySchema>;

export const DeviceSchema = z.enum(['desktop', 'mobile', 'tablet']);
export type Device = z.infer<typeof DeviceSchema>;

/**
 * Behavioural parameters of a simulated user. Every trait in [0, 1] is a knob the calibration
 * loop can tune; the engine turns them into concrete perception and patience policies.
 */
export const PersonaTraitsSchema = z.object({
  role: z.string().min(1).describe('Job or life role, e.g. "owner of a 12-person agency"'),
  techProficiency: ProficiencySchema.default('intermediate'),
  patience: UnitSchema.default(0.5).describe(
    'Tolerance for fruitless steps before abandoning: 0 leaves at the first friction, 1 is very persistent',
  ),
  attention: UnitSchema.default(0.5).describe(
    'Fraction of a page the user actually takes in: 0 skims headlines and buttons, 1 reads everything',
  ),
  domainFamiliarity: UnitSchema.default(0.5).describe(
    'Prior knowledge of this product category and its jargon',
  ),
  riskTolerance: UnitSchema.default(0.5).describe('Willingness to hand over data, pay, or commit'),
  priceSensitivity: UnitSchema.default(0.5),
});
export type PersonaTraits = z.infer<typeof PersonaTraitsSchema>;

export const PersonaSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  summary: z.string().min(1).describe('One paragraph, written in the second person, used verbatim in the agent prompt'),
  traits: PersonaTraitsSchema,
  goals: z.array(z.string().min(1)).default([]),
  frustrations: z.array(z.string().min(1)).default([]),
  device: DeviceSchema.default('desktop'),
  locale: z.string().min(2).default('en-US'),
  tags: z.array(z.string()).default([]),
});
export type Persona = z.infer<typeof PersonaSchema>;
export type PersonaInput = z.input<typeof PersonaSchema>;

/** Reference from a population to a persona definition, with a sampling weight. */
export const PersonaRefSchema = z.object({
  use: z
    .string()
    .min(1)
    .describe(
      '"builtin/<id>" for the bundled library, a path to a persona YAML file, or the id of an inline persona in this config',
    ),
  weight: z.number().positive().default(1),
});
export type PersonaRef = z.infer<typeof PersonaRefSchema>;

export const BUILTIN_PERSONA_PREFIX = 'builtin/';

export function personaRefKind(ref: PersonaRef): 'builtin' | 'file' | 'inline' {
  if (ref.use.startsWith(BUILTIN_PERSONA_PREFIX)) return 'builtin';
  if (ref.use.startsWith('./') || ref.use.startsWith('../') || ref.use.startsWith('/')) return 'file';
  return 'inline';
}

/** A persona as sampled for one session: jittered traits plus the model that will play it. */
export const PersonaInstanceSchema = z.object({
  personaId: SlugSchema,
  name: z.string(),
  summary: z.string(),
  traits: PersonaTraitsSchema,
  goals: z.array(z.string()),
  frustrations: z.array(z.string()),
  device: DeviceSchema,
  locale: z.string(),
  model: ModelRefSchema,
  seed: z.number().int().nonnegative(),
  distinctId: z.string().min(1).describe('Stable analytics identity for this simulated user'),
});
export type PersonaInstance = z.infer<typeof PersonaInstanceSchema>;
