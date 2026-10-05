import { z } from 'zod';
import { ModelRefSchema, UnitSchema } from './common.js';
import { PersonaRefSchema } from './persona.js';

export const PopulationSchema = z.object({
  seed: z.number().int().nonnegative().default(0),
  size: z.number().int().positive().max(100_000).describe('Sessions per run, spread over variants'),
  models: z
    .array(ModelRefSchema)
    .default([])
    .describe('LLM backends to spread the population across; empty means defaults.model'),
  personas: z.array(PersonaRefSchema).min(1),
  traitJitter: UnitSchema.default(0.1).describe(
    'Standard deviation of per-instance noise added to each persona trait',
  ),
});
export type Population = z.infer<typeof PopulationSchema>;
export type PopulationInput = z.input<typeof PopulationSchema>;
