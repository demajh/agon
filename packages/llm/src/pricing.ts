import type { ModelRef } from '@agon/spec';

/** USD per one million tokens. Cache-read and cache-write discounts are not modelled. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Pricing keyed by `ModelRef` (`<provider>/<model>`). A key also prices any model id that extends
 * it with a `-` or `:` suffix, so `anthropic/claude-sonnet-5-5` covers a dated snapshot such as
 * `anthropic/claude-sonnet-5-5-20260401`.
 */
export type PricingTable = Record<string, ModelPricing>;

const usd = (inputPerMillion: number, outputPerMillion: number): ModelPricing => ({
  inputPerMillion,
  outputPerMillion,
});

/**
 * Approximate list prices as of October 2026. This table is a convenience, not a source of truth:
 * extend or override it through `createLlmClient({ pricing })` (entries merge over these) or
 * pass your own table to `computeCostUsd`. Models missing from the table are accounted at $0 and
 * reported by `isPriced()`; the client logs one warning per unknown model.
 */
export const DEFAULT_PRICING: PricingTable = {
  // Anthropic
  'anthropic/claude-fable-5-1': usd(10, 50),
  'anthropic/claude-fable-5': usd(10, 50),
  'anthropic/claude-opus-5-5': usd(4, 20),
  'anthropic/claude-opus-5': usd(5, 25),
  'anthropic/claude-opus-4-8': usd(5, 25),
  'anthropic/claude-opus-4-7': usd(5, 25),
  'anthropic/claude-opus-4-6': usd(5, 25),
  'anthropic/claude-opus-4-5': usd(5, 25),
  'anthropic/claude-opus-4-1': usd(15, 75),
  'anthropic/claude-opus-4': usd(15, 75),
  'anthropic/claude-sonnet-5-5': usd(2, 10),
  'anthropic/claude-sonnet-5': usd(2, 10),
  'anthropic/claude-sonnet-4-6': usd(3, 15),
  'anthropic/claude-sonnet-4-5': usd(3, 15),
  'anthropic/claude-sonnet-4': usd(3, 15),
  'anthropic/claude-haiku-4-5': usd(1, 5),
  'anthropic/claude-3-5-haiku': usd(0.8, 4),
  // OpenAI
  'openai/gpt-5.2': usd(1.75, 14),
  'openai/gpt-5.1': usd(1.25, 10),
  'openai/gpt-5': usd(1.25, 10),
  'openai/gpt-5-mini': usd(0.25, 2),
  'openai/gpt-5-nano': usd(0.05, 0.4),
  'openai/gpt-4.1': usd(2, 8),
  'openai/gpt-4.1-mini': usd(0.4, 1.6),
  'openai/gpt-4.1-nano': usd(0.1, 0.4),
  'openai/gpt-4o': usd(2.5, 10),
  'openai/gpt-4o-mini': usd(0.15, 0.6),
  'openai/o3': usd(2, 8),
  'openai/o4-mini': usd(1.1, 4.4),
};

const SUFFIX_BOUNDARY = new Set(['-', ':']);

/**
 * Finds the pricing entry for a model: an exact key first, then the longest key that the model
 * id extends with a `-`/`:` suffix (dated snapshots, tags). `undefined` when nothing matches.
 */
export function resolvePricing(
  model: ModelRef,
  table: PricingTable = DEFAULT_PRICING,
): ModelPricing | undefined {
  const exact = table[model];
  if (exact) return exact;
  let bestKey = '';
  let best: ModelPricing | undefined;
  for (const [key, pricing] of Object.entries(table)) {
    if (
      key.length > bestKey.length &&
      model.startsWith(key) &&
      SUFFIX_BOUNDARY.has(model.charAt(key.length))
    ) {
      bestKey = key;
      best = pricing;
    }
  }
  return best;
}

export function isPriced(model: ModelRef, table: PricingTable = DEFAULT_PRICING): boolean {
  return resolvePricing(model, table) !== undefined;
}

/** Cost in USD for a call, or `undefined` when the model is not in the table. */
export function computeCostUsd(
  model: ModelRef,
  inputTokens: number,
  outputTokens: number,
  table: PricingTable = DEFAULT_PRICING,
): number | undefined {
  const pricing = resolvePricing(model, table);
  if (!pricing) return undefined;
  return (
    (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000
  );
}

/**
 * Rough token estimate (about four characters per token for English and JSON). Used by
 * `FakeLlmClient` and for pre-flight sizing; never for billing real calls, which use the
 * provider's own counts.
 */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}
