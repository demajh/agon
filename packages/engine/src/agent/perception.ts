import type { Observation, PersonaInstance, PersonaTraits } from '@agon/spec';

export interface PerceptionLimits {
  maxTextChars: number;
  maxInteractive: number;
}

/** How much of a page this persona takes in. Attention 0 skims; attention 1 reads everything. */
export function perceptionLimits(traits: PersonaTraits): PerceptionLimits {
  const a = traits.attention;
  return {
    maxTextChars: Math.round(600 + a * 3400),
    maxInteractive: Math.round(8 + a * 32),
  };
}

/** Cuts an observation down to the persona's attention. Idempotent when already within limits. */
export function pruneObservation(observation: Observation, limits: PerceptionLimits): Observation {
  const text =
    observation.text.length > limits.maxTextChars
      ? observation.text.slice(0, limits.maxTextChars).replace(/\s+\S*$/, '') + ' …'
      : observation.text;
  const interactive =
    observation.interactive.length > limits.maxInteractive
      ? observation.interactive.slice(0, limits.maxInteractive)
      : observation.interactive;
  const truncated =
    observation.truncated ||
    text !== observation.text ||
    interactive.length !== observation.interactive.length;
  return { ...observation, text, interactive, truncated };
}

/**
 * Limits for a sampled persona: agents read the catalog in proportion to how carefully their
 * harness reads descriptions and see every ref; people are limited by attention.
 */
export function perceptionLimitsFor(
  persona: Pick<PersonaInstance, 'traits' | 'harness'>,
): PerceptionLimits {
  if (persona.harness) {
    return {
      maxTextChars: Math.round(1500 + persona.harness.readsDescriptions * 10_500),
      maxInteractive: 60,
    };
  }
  return perceptionLimits(persona.traits);
}
