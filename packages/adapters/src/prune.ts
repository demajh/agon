import type { Observation } from '@agon/spec';
import { cutText } from './web/observe.js';

export const PRUNE_MIN_INTERACTIVE = 5;
export const PRUNE_MIN_TEXT_CHARS = 400;

export interface PruneOptions {
  /** Persona attention in [0, 1]: the fraction of the page this user actually takes in. */
  attention: number;
  /** Floor on interactive elements kept (unless the page has fewer). Default 5. */
  minInteractive?: number;
  /** Floor on readable characters kept (unless the page has fewer). Default 400. */
  minTextChars?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Perception degradation: keeps the first `attention` share of the text and of the interactive
 * list (document order, so above-the-fold content survives), never dropping below the floors.
 * Pure; the input is not mutated. The hash is left untouched: it identifies the page state the
 * adapter observed, and the engine keys any per-persona cache on (hash, persona) itself.
 */
export function pruneObservation(observation: Observation, options: PruneOptions): Observation {
  const attention = clamp01(options.attention);
  const minInteractive = Math.max(0, Math.floor(options.minInteractive ?? PRUNE_MIN_INTERACTIVE));
  const minTextChars = Math.max(0, Math.floor(options.minTextChars ?? PRUNE_MIN_TEXT_CHARS));

  const totalInteractive = observation.interactive.length;
  const keepInteractive = Math.min(
    totalInteractive,
    Math.max(minInteractive, Math.ceil(totalInteractive * attention)),
  );
  const totalChars = observation.text.length;
  const keepChars = Math.min(totalChars, Math.max(minTextChars, Math.ceil(totalChars * attention)));

  const interactive = observation.interactive.slice(0, keepInteractive);
  const text = cutText(
    observation.text,
    keepChars,
    Math.max(minTextChars, Math.floor(keepChars * 0.8)),
  );
  const truncated =
    observation.truncated || interactive.length < totalInteractive || text.length < totalChars;

  return { ...observation, text, interactive, errors: [...observation.errors], truncated };
}
