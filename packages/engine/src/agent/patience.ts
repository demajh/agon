import type { Feeling, PersonaTraits, Progress } from '@agon/spec';
import { clamp01, type Rng } from '../rng.js';

/**
 * Parameters of the abandonment policy. These are the knobs a calibration profile tunes;
 * the defaults are a starting point, not a measurement.
 */
export interface PatienceParams {
  /** Patience every user starts with regardless of trait. */
  base: number;
  /** How much the persona's patience trait adds on top of base. */
  traitWeight: number;
  /** Drain when the last action produced no progress (scaled by impatience). */
  noProgress: number;
  /** Drain when the last action made things worse. */
  regress: number;
  /** Extra drain when the user reports feeling confused / frustrated. */
  confused: number;
  frustrated: number;
  /** Drain per failed action and per visible error on the page. */
  error: number;
  /** Recovery when the user feels they made progress. */
  recover: number;
  /** Below this remaining patience, abandonment becomes stochastic. */
  abandonBelow: number;
  /** Maximum per-step abandonment probability as patience approaches zero. */
  abandonSlope: number;
}

export const DEFAULT_PATIENCE: PatienceParams = {
  base: 0.35,
  traitWeight: 0.65,
  noProgress: 0.08,
  regress: 0.16,
  confused: 0.04,
  frustrated: 0.08,
  error: 0.05,
  recover: 0.03,
  abandonBelow: 0.25,
  abandonSlope: 0.8,
};

export function initialPatience(
  traits: PersonaTraits,
  params: PatienceParams = DEFAULT_PATIENCE,
): number {
  return clamp01(params.base + params.traitWeight * traits.patience);
}

export interface PatienceInput {
  traits: PersonaTraits;
  progress: Progress;
  feeling: Feeling;
  /** Errors visible on the page at this step. */
  errors: number;
  actionOk: boolean;
}

export function updatePatience(
  current: number,
  input: PatienceInput,
  params: PatienceParams = DEFAULT_PATIENCE,
): number {
  const impatience = 1.3 - input.traits.patience; // 0.3 (saint) .. 1.3 (hair trigger)
  let delta = 0;
  switch (input.progress) {
    case 'progress':
      delta += params.recover;
      break;
    case 'none':
      delta -= params.noProgress * impatience;
      break;
    case 'regress':
      delta -= params.regress * impatience;
      break;
  }
  if (input.feeling === 'confused') delta -= params.confused * impatience;
  if (input.feeling === 'frustrated') delta -= params.frustrated * impatience;
  if (!input.actionOk) delta -= params.error * impatience;
  delta -= Math.min(input.errors, 3) * params.error * impatience * 0.5;
  return clamp01(current + delta);
}

/** Stochastic abandonment: certain at zero patience, increasingly likely below the threshold. */
export function shouldAbandon(
  patience: number,
  rng: Rng,
  params: PatienceParams = DEFAULT_PATIENCE,
): boolean {
  if (patience <= 0) return true;
  if (patience >= params.abandonBelow) return false;
  const probability =
    ((params.abandonBelow - patience) / params.abandonBelow) * params.abandonSlope;
  return rng.next() < probability;
}
