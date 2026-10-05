import type { AgonConfig, Result } from '@agon/spec';

/**
 * Which squads a config credits, and with which variants: `target.variants[*].squad` per variant,
 * plus `squad.id` for every variant when set.
 */
export function creditedSquads(config: AgonConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (slug: string, variant: string): void => {
    const list = out.get(slug) ?? [];
    if (!list.includes(variant)) list.push(variant);
    out.set(slug, list);
  };
  for (const [name, spec] of Object.entries(config.target.variants)) {
    if (spec.squad) add(spec.squad, name);
    if (config.squad) add(config.squad.id, name);
  }
  return out;
}

export interface BestComparison {
  variant: string;
  pBest: number;
  lift: number;
}

/**
 * The primary metric's strongest treatment (highest P(best)), optionally restricted to some
 * variants. Undefined when the result has no comparisons for them.
 */
export function bestComparison(
  result: Result,
  variants?: readonly string[],
): BestComparison | undefined {
  const primary =
    result.metrics.find((m) => m.metricId === result.primaryMetricId) ?? result.metrics[0];
  if (!primary) return undefined;
  let best: BestComparison | undefined;
  for (const c of primary.comparisons) {
    if (variants && !variants.includes(c.variant)) continue;
    if (!best || c.pBest > best.pBest) best = { variant: c.variant, pBest: c.pBest, lift: c.lift };
  }
  return best;
}

/** Whether the result ships one of the given variants. */
export function isWin(result: Result, variants: readonly string[]): boolean {
  return (
    result.decision.verdict === 'ship' &&
    result.decision.variant !== undefined &&
    variants.includes(result.decision.variant)
  );
}

/** Whether the result kills the squad's work, or ships somebody else's. */
export function isLoss(result: Result, variants: readonly string[]): boolean {
  if (result.decision.verdict === 'kill') return true;
  return (
    result.decision.verdict === 'ship' &&
    result.decision.variant !== undefined &&
    !variants.includes(result.decision.variant)
  );
}
