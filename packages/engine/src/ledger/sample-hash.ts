import { createHash } from 'node:crypto';
import type { AgonConfig, Persona, VariantSpec } from '@agon/spec';
import type { ResolvedPersona } from '../population/personas.js';

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

/** JSON with object keys sorted at every level, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, normalize(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(value));
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The stable hash the evaluation ledger is keyed by. */
export function sampleHash(identity: SampleIdentity): string {
  return sha256(canonicalJson(identity));
}

/**
 * Identifies a variant for the ledger by its name and the hash of its spec, so a redeploy under
 * the same name with another url, command, image, env, headers or gitRef counts as a new trial.
 */
export function variantKey(name: string, spec: VariantSpec): string {
  const { url, image, command, env, headers, gitRef } = spec;
  return `${name}@${sha256(canonicalJson({ url, image, command, env, headers, gitRef })).slice(0, 12)}`;
}
