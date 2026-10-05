import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING,
  computeCostUsd,
  estimateTokens,
  isPriced,
  resolvePricing,
} from './pricing.js';

describe('pricing table', () => {
  it('prices every entry with positive numbers keyed by a model ref', () => {
    for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
      expect(key).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/);
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('resolves exact keys, dated snapshots and tags, but not unrelated ids', () => {
    expect(resolvePricing('anthropic/claude-sonnet-5-5')).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 10,
    });
    expect(resolvePricing('anthropic/claude-sonnet-5-5-20260401')).toEqual(
      DEFAULT_PRICING['anthropic/claude-sonnet-5-5'],
    );
    expect(resolvePricing('openai/gpt-5-mini-2026-01-01')).toEqual(
      DEFAULT_PRICING['openai/gpt-5-mini'],
    );
    expect(resolvePricing('openai/gpt-5.1-codex')).toEqual(DEFAULT_PRICING['openai/gpt-5.1']);
    expect(
      resolvePricing('openai/gpt-5:fast', {
        'openai/gpt-5': { inputPerMillion: 1, outputPerMillion: 2 },
      }),
    ).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
    expect(resolvePricing('anthropic/claude-sonnet-55')).toBeUndefined();
    expect(resolvePricing('local/llama-3-8b')).toBeUndefined();
    expect(resolvePricing('openai/gpt-5.9')).toBeUndefined();
  });

  it('prefers the longest matching key', () => {
    expect(resolvePricing('anthropic/claude-sonnet-4-5-20250929')).toEqual(
      DEFAULT_PRICING['anthropic/claude-sonnet-4-5'],
    );
    expect(resolvePricing('anthropic/claude-opus-4-1-20250805')).toEqual(
      DEFAULT_PRICING['anthropic/claude-opus-4-1'],
    );
  });

  it('computes USD from tokens and reports unknown models as unpriced', () => {
    expect(computeCostUsd('anthropic/claude-sonnet-5-5', 1_000_000, 100_000)).toBeCloseTo(3, 9);
    expect(computeCostUsd('openai/gpt-5-mini', 4_000, 1_000)).toBeCloseTo(0.001 + 0.002, 9);
    expect(computeCostUsd('local/llama-3-8b', 10, 10)).toBeUndefined();
    expect(isPriced('anthropic/claude-haiku-4-5')).toBe(true);
    expect(isPriced('local/llama-3-8b')).toBe(false);
    expect(
      computeCostUsd('local/llama-3-8b', 1_000_000, 0, {
        'local/llama-3-8b': { inputPerMillion: 0.1, outputPerMillion: 0.2 },
      }),
    ).toBeCloseTo(0.1, 9);
  });

  it('estimates roughly four characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});
