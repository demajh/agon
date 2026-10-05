import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@agon/spec';
import * as llm from './index.js';
import type { LlmLogger } from './index.js';

describe('@agon/llm public API', () => {
  it('exports the client factory, the fake client and the helpers', () => {
    expect(typeof llm.createLlmClient).toBe('function');
    expect(typeof llm.FakeLlmClient).toBe('function');
    expect(typeof llm.estimateTokens).toBe('function');
    expect(typeof llm.computeCostUsd).toBe('function');
    expect(typeof llm.isPriced).toBe('function');
    expect(typeof llm.computeCacheKey).toBe('function');
    expect(llm.LLM_MODES).toEqual(['live', 'record', 'replay', 'off']);
    expect(llm.LLM_PROVIDERS).toEqual(['anthropic', 'openai', 'openai-compatible', 'local']);
    expect(llm.DEFAULT_CACHE_DIR).toBe('.agon/llm-cache');
    expect(Object.keys(llm.DEFAULT_PRICING).length).toBeGreaterThan(10);
  });

  it('produces objects that satisfy the spec LlmClient interface', () => {
    const real: LlmClient = llm.createLlmClient({ env: {} });
    const fake: LlmClient = new llm.FakeLlmClient([]);
    expect(real).toBeDefined();
    expect(fake).toBeDefined();
  });

  it('accepts a pino logger (and child logger) as LlmLogger', () => {
    const root = pino({ level: 'silent' });
    const logger: LlmLogger = root;
    const child: LlmLogger = root.child({ pkg: 'llm' });
    expect(() => logger.info({ a: 1 }, 'hello')).not.toThrow();
    expect(() => child.warn({ b: 2 })).not.toThrow();
    expect(() => llm.noopLogger.error({ c: 3 }, 'silent')).not.toThrow();
  });
});
