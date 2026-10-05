import {
  deterministicId,
  type AgonConfig,
  type PersonaInstance,
  type PersonaTraits,
  type Scenario,
} from '@agon/spec';
import { clamp01, createRng, hashSeed, type Rng } from '../rng.js';
import type { ResolvedPersona } from './personas.js';

export interface SessionPlan {
  index: number;
  sessionId: string;
  variant: string;
  scenario: Scenario;
  persona: PersonaInstance;
}

export interface PlanOptions {
  runId: string;
  variants: readonly string[];
  seed: number;
  size: number;
  /** Used when population.models is empty. */
  defaultModel: string;
}

const JITTERED_TRAITS = [
  'patience',
  'attention',
  'domainFamiliarity',
  'riskTolerance',
  'priceSensitivity',
] as const satisfies readonly (keyof PersonaTraits)[];

export function jitterTraits(traits: PersonaTraits, sd: number, rng: Rng): PersonaTraits {
  if (sd <= 0) return { ...traits };
  const out: PersonaTraits = { ...traits };
  for (const key of JITTERED_TRAITS) {
    out[key] = clamp01(traits[key] + rng.gaussian() * sd);
  }
  return out;
}

/**
 * Expands a config into concrete session plans. Fully determined by (seed, size, variants):
 * the same inputs always produce the same personas, scenarios, models and variant assignment.
 * Variants are assigned round-robin over a seeded order so arms stay balanced at any size.
 */
export function planSessions(
  config: AgonConfig,
  personas: ResolvedPersona[],
  options: PlanOptions,
): SessionPlan[] {
  if (personas.length === 0) throw new RangeError('planSessions: no personas resolved');
  if (options.variants.length === 0) throw new RangeError('planSessions: no variants');
  const models =
    config.population.models.length > 0 ? config.population.models : [options.defaultModel];
  const personaWeights = personas.map((p) => p.weight);
  const scenarioWeights = config.scenarios.map((s) => s.weight);
  const variantOrder = createRng(hashSeed(options.seed, 'variant-order')).shuffle(options.variants);
  const runSuffix = options.runId.includes('_')
    ? options.runId.slice(options.runId.indexOf('_') + 1)
    : options.runId;

  const plans: SessionPlan[] = [];
  for (let i = 0; i < options.size; i++) {
    const seed = hashSeed(options.seed, 'session', i);
    const rng = createRng(seed);
    const variant = variantOrder[i % variantOrder.length] as string;
    const resolved = personas[rng.pick(personaWeights)] as ResolvedPersona;
    const scenario = config.scenarios[rng.pick(scenarioWeights)] as Scenario;
    const model = models[rng.int(0, models.length - 1)] as string;
    const p = resolved.persona;
    plans.push({
      index: i,
      sessionId: deterministicId('ses', options.runId, i),
      variant,
      scenario,
      persona: {
        personaId: p.id,
        name: p.name,
        summary: p.summary,
        traits: jitterTraits(p.traits, config.population.traitJitter, rng),
        goals: [...p.goals],
        frustrations: [...p.frustrations],
        device: p.device,
        locale: p.locale,
        ...(p.harness === undefined ? {} : { harness: p.harness }),
        model,
        seed,
        distinctId: `sim_${runSuffix}_${String(i).padStart(5, '0')}`,
      },
    });
  }
  return plans;
}
