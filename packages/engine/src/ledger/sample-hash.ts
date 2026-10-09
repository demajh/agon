import { canonicalJson, sha256Hex } from '@agon/spec';
import type { AgonConfig, Persona, VariantSpec } from '@agon/spec';
import type { ResolvedPersona } from '../population/personas.js';

// Kept on the engine's surface for callers that imported it from here; it lives in @agon/spec now
// so the requirements digest and the diff hashes share the same serialization.
export { canonicalJson } from '@agon/spec';

/**
 * Everything that defines the sample of simulated users and tasks a run evaluates against, and
 * nothing about the variants: the resolved population and personas, the scenarios, the seed and
 * size, the analysis settings (calibration profile included), the models playing the users and
 * the judge, and the target's identity (kind, capture, hooks, viewport).
 */
export interface SampleIdentity {
  target: Omit<AgonConfig['target'], 'variants'>;
  population: AgonConfig['population'];
  personas: { persona: Persona; weight: number }[];
  scenarios: AgonConfig['scenarios'];
  analysis: AgonConfig['analysis'];
  models: { user: string; judge: string | undefined; temperature: number };
  seed: number;
  size: number;
}

export function sampleIdentity(
  config: AgonConfig,
  personas: readonly ResolvedPersona[],
  run: { seed: number; size: number },
): SampleIdentity {
  const { variants: _variants, ...target } = config.target;
  return {
    target,
    population: config.population,
    personas: personas.map((p) => ({ persona: p.persona, weight: p.weight })),
    scenarios: config.scenarios,
    analysis: config.analysis,
    models: {
      user: config.defaults.model,
      judge: config.defaults.judgeModel,
      temperature: config.defaults.temperature,
    },
    seed: run.seed,
    size: run.size,
  };
}

/** The stable hash the evaluation ledger is keyed by. */
export function sampleHash(identity: SampleIdentity): string {
  return sha256Hex(canonicalJson(identity));
}

/**
 * Identifies a variant for the ledger by its name and the hash of its spec, so a redeploy under
 * the same name with another url, command, image, env, headers or gitRef counts as a new trial.
 */
export function variantKey(name: string, spec: VariantSpec): string {
  const { url, image, command, env, headers, gitRef } = spec;
  return `${name}@${sha256Hex(canonicalJson({ url, image, command, env, headers, gitRef })).slice(0, 12)}`;
}
