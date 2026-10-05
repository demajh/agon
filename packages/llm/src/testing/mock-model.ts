import { MockLanguageModelV3 } from 'ai/test';

/** Types derived from the mock so tests need no direct dependency on `@ai-sdk/provider`. */
export type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
export type MockCallOptions = MockLanguageModelV3['doGenerateCalls'][number];
export type MockResponder = (
  options: MockCallOptions,
) => MockGenerateResult | Promise<MockGenerateResult>;

/** A completed text generation with the given token counts (defaults: 100 in, 20 out). */
export function textResult(
  text: string,
  tokens: { input?: number; output?: number } = {},
): MockGenerateResult {
  const input = tokens.input ?? 100;
  const output = tokens.output ?? 20;
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: output, text: output, reasoning: undefined },
    },
    warnings: [],
  };
}

/**
 * A language model that answers successive calls from `responses`; the last entry repeats once
 * the list is exhausted. A function entry is invoked (and may throw) to simulate failures.
 */
export function mockModel(
  responses: ReadonlyArray<MockGenerateResult | MockResponder>,
  meta: { provider?: string; modelId?: string } = {},
): MockLanguageModelV3 {
  if (responses.length === 0) throw new Error('mockModel needs at least one response');
  let index = 0;
  return new MockLanguageModelV3({
    provider: meta.provider ?? 'mock',
    modelId: meta.modelId ?? 'mock-model',
    doGenerate: async (options) => {
      const next = responses[Math.min(index, responses.length - 1)] as
        MockGenerateResult | MockResponder;
      index++;
      return typeof next === 'function' ? next(options) : next;
    },
  });
}

/** The prompt a mock received, flattened to a string for `toContain` assertions. */
export function promptText(options: MockCallOptions): string {
  return JSON.stringify(options.prompt);
}
