import { describe, expect, it } from 'vitest';
import { LlmError } from '@agon/spec';
import { createLlmClient } from './client.js';
import { ModelRouter, assertModelRef, providerSettingsFromEnv } from './routing.js';
import { mockModel, textResult } from './testing/mock-model.js';

function failure(fn: () => unknown): LlmError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error('expected the call to throw');
}

describe('assertModelRef', () => {
  it('accepts <provider>/<model> and rejects anything else with an LlmError', () => {
    expect(assertModelRef('openai/gpt-5')).toBe('openai/gpt-5');
    expect(assertModelRef('local/llama3:8b')).toBe('local/llama3:8b');
    for (const bad of ['gpt-5', 'Open-AI/gpt-5', 'openai/', '/gpt-5', 'a/b/c']) {
      const error = failure(() => assertModelRef(bad));
      expect(error.message).toContain('expected "<provider>/<model>"');
      expect(error.details).toEqual({ model: bad });
    }
  });
});

describe('providerSettingsFromEnv', () => {
  it('reads the documented variables and ignores empty ones', () => {
    expect(providerSettingsFromEnv({})).toEqual({});
    expect(
      providerSettingsFromEnv({
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: '',
        OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1',
      }),
    ).toEqual({
      anthropic: { apiKey: 'a' },
      openaiCompatible: { baseURL: 'http://localhost:11434/v1' },
    });
    expect(
      providerSettingsFromEnv({
        OPENAI_API_KEY: 'o',
        OPENAI_COMPATIBLE_BASE_URL: 'http://proxy/v1',
        OPENAI_COMPATIBLE_API_KEY: 'p',
      }),
    ).toEqual({
      openai: { apiKey: 'o' },
      openaiCompatible: { baseURL: 'http://proxy/v1', apiKey: 'p' },
    });
  });
});

describe('ModelRouter', () => {
  it('explains which variable or option configures a missing provider', () => {
    const router = new ModelRouter({});
    const anthropic = failure(() => router.resolve('anthropic/claude-sonnet-5-5'));
    expect(anthropic.message).toContain('ANTHROPIC_API_KEY');
    expect(anthropic.message).toContain('providers.anthropic.apiKey');
    expect(anthropic.details).toMatchObject({ provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });

    const openai = failure(() => router.resolve('openai/gpt-5'));
    expect(openai.message).toContain('OPENAI_API_KEY');
    expect(openai.message).toContain('providers.openai.apiKey');

    for (const ref of ['openai-compatible/llama3', 'local/llama3']) {
      const error = failure(() => router.resolve(ref));
      expect(error.message).toContain('OPENAI_COMPATIBLE_BASE_URL');
      expect(error.message).toContain('providers.openaiCompatible.baseURL');
    }
  });

  it('rejects unknown providers and lists the known ones', () => {
    const error = failure(() => new ModelRouter({}).resolve('mistral/large'));
    expect(error.message).toContain('unknown LLM provider "mistral"');
    expect(error.message).toContain('anthropic, openai, openai-compatible, local');
    expect(error.details).toMatchObject({ provider: 'mistral' });
  });

  it('routes each provider prefix to the matching SDK model without network access', () => {
    const router = new ModelRouter({
      anthropic: { apiKey: 'test-anthropic' },
      openai: { apiKey: 'test-openai' },
      openaiCompatible: { baseURL: 'http://localhost:11434/v1', name: 'ollama' },
    });
    const claude = router.resolve('anthropic/claude-sonnet-5-5');
    expect(claude.modelId).toBe('claude-sonnet-5-5');
    expect(claude.provider).toContain('anthropic');

    const gpt = router.resolve('openai/gpt-5-mini');
    expect(gpt.modelId).toBe('gpt-5-mini');
    expect(gpt.provider).toContain('openai');

    const local = router.resolve('local/llama3:8b');
    expect(local.modelId).toBe('llama3:8b');
    expect(local.provider).toContain('ollama');
    expect(router.resolve('openai-compatible/qwen').provider).toContain('ollama');

    expect(router.resolve('anthropic/claude-sonnet-5-5')).toBe(claude);
  });

  it('only needs credentials for the provider actually used', () => {
    const router = new ModelRouter({ openai: { apiKey: 'k' } });
    expect(router.resolve('openai/gpt-5').modelId).toBe('gpt-5');
    expect(() => router.resolve('anthropic/claude-haiku-4-5')).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('prefers injected model instances over provider routing', () => {
    const fake = mockModel([textResult('hi')]);
    const router = new ModelRouter({}, { 'anthropic/claude-sonnet-5-5': fake });
    expect(router.resolve('anthropic/claude-sonnet-5-5')).toBe(fake);
  });
});

describe('createLlmClient routing', () => {
  it('reads credentials from the supplied environment and merges explicit providers over it', () => {
    const fromEnv = createLlmClient({ env: { OPENAI_API_KEY: 'k' } });
    expect(fromEnv.resolveModel('openai/gpt-5').modelId).toBe('gpt-5');
    expect(() => fromEnv.resolveModel('anthropic/claude-haiku-4-5')).toThrow(LlmError);

    const merged = createLlmClient({
      env: { OPENAI_API_KEY: 'k' },
      providers: { anthropic: { apiKey: 'a' } },
    });
    expect(merged.resolveModel('anthropic/claude-haiku-4-5').modelId).toBe('claude-haiku-4-5');
    expect(merged.resolveModel('openai/gpt-5').modelId).toBe('gpt-5');
  });

  it('fails a call for an unconfigured provider before any request is made', async () => {
    const client = createLlmClient({ env: {} });
    await expect(
      client.generateText({ model: 'anthropic/claude-haiku-4-5', system: '', messages: [] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(client.totals().calls).toBe(0);
  });
});
