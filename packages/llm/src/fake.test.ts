import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from '@agon/spec';
import type { LlmClient } from '@agon/spec';
import { FakeLlmClient } from './fake.js';
import { estimateTokens } from './pricing.js';

const Decision = z.object({ action: z.enum(['click', 'done']), reason: z.string().min(1) });
const MODEL = 'anthropic/claude-haiku-4-5';
const request = {
  model: MODEL,
  system: 'You are a cautious user.',
  messages: [{ role: 'user' as const, content: 'The page shows a Sign up button.' }],
  temperature: 0.2,
  cacheKey: 'ses_1/step-1',
  purpose: 'act' as const,
};

describe('FakeLlmClient', () => {
  it('implements LlmClient', () => {
    const client: LlmClient = new FakeLlmClient([]);
    expect(client).toBeDefined();
  });

  it('answers from a handler, validates objects and records every call', async () => {
    const fake = new FakeLlmClient((call) =>
      call.kind === 'object'
        ? { action: 'click', reason: `saw ${call.messages.length} message(s)` }
        : 'plain text',
    );
    const object = await fake.generateObject({
      ...request,
      schema: Decision,
      schemaName: 'Decision',
    });
    expect(object.object).toEqual({ action: 'click', reason: 'saw 1 message(s)' });
    const text = await fake.generateText({ ...request, purpose: 'judge' });
    expect(text.text).toBe('plain text');

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({
      index: 1,
      kind: 'object',
      model: MODEL,
      system: request.system,
      temperature: 0.2,
      cacheKey: 'ses_1/step-1',
      purpose: 'act',
      schemaName: 'Decision',
      schema: Decision,
    });
    expect(fake.calls[1]).toMatchObject({ index: 2, kind: 'text', purpose: 'judge' });
    expect(fake.calls[1]).not.toHaveProperty('schema');
  });

  it('reports estimated usage priced from the pricing table', async () => {
    const fake = new FakeLlmClient([{ action: 'done', reason: 'finished' }], { latencyMs: 5 });
    const { usage } = await fake.generateObject({ ...request, schema: Decision });
    const promptTokens = estimateTokens(`${request.system}\n${request.messages[0]!.content}`);
    const outputTokens = estimateTokens(JSON.stringify({ action: 'done', reason: 'finished' }));
    expect(usage).toEqual({
      model: MODEL,
      inputTokens: promptTokens,
      outputTokens,
      costUsd: (promptTokens * 1 + outputTokens * 5) / 1_000_000,
      latencyMs: 5,
      cached: false,
    });
    expect(fake.totalCostUsd).toBe(usage.costUsd);
    expect(fake.totals()).toEqual({
      calls: 1,
      inputTokens: promptTokens,
      outputTokens,
      costUsd: usage.costUsd,
    });
  });

  it('charges nothing for models missing from the pricing table', async () => {
    const fake = new FakeLlmClient(['ok']);
    const { usage } = await fake.generateText({ ...request, model: 'local/llama3' });
    expect(usage.costUsd).toBe(0);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  it('consumes a scripted queue in order, invoking function entries', async () => {
    const fake = new FakeLlmClient([
      { action: 'click', reason: 'first' },
      'second',
      (call) => ({ action: 'done', reason: `third on ${call.model}` }),
    ]);
    expect(fake.remaining).toBe(3);
    await expect(fake.generateObject({ ...request, schema: Decision })).resolves.toMatchObject({
      object: { action: 'click', reason: 'first' },
    });
    await expect(fake.generateText(request)).resolves.toMatchObject({ text: 'second' });
    await expect(fake.generateObject({ ...request, schema: Decision })).resolves.toMatchObject({
      object: { action: 'done', reason: `third on ${MODEL}` },
    });
    expect(fake.remaining).toBe(0);
    const exhausted = fake.generateText(request);
    await expect(exhausted).rejects.toBeInstanceOf(LlmError);
    await expect(exhausted).rejects.toThrow(/no scripted response left for call #4/);
  });

  it('fails fast when a scripted object does not satisfy the request schema', async () => {
    const fake = new FakeLlmClient([{ action: 'fly', reason: '' }]);
    const promise = fake.generateObject({ ...request, schema: Decision });
    await expect(promise).rejects.toBeInstanceOf(LlmError);
    await expect(promise).rejects.toThrow(/does not match the request schema/);
    const error = (await promise.catch((e: unknown) => e)) as LlmError;
    expect(error.details).toMatchObject({
      call: 1,
      model: MODEL,
      response: { action: 'fly', reason: '' },
    });
    expect((error.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('serialises non-string text responses and applies schema defaults', async () => {
    const WithDefault = z.object({ action: z.string(), confidence: z.number().default(0.5) });
    const fake = new FakeLlmClient([{ action: 'click' }, { answer: 42 }]);
    const { object } = await fake.generateObject({ ...request, schema: WithDefault });
    expect(object).toEqual({ action: 'click', confidence: 0.5 });
    const { text } = await fake.generateText(request);
    expect(text).toBe('{"answer":42}');
  });

  it('reset forgets calls and totals but keeps the queue', async () => {
    const fake = new FakeLlmClient(['a', 'b']);
    await fake.generateText(request);
    expect(fake.calls).toHaveLength(1);
    fake.reset();
    expect(fake.calls).toHaveLength(0);
    expect(fake.totals()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(fake.remaining).toBe(1);
    await expect(fake.generateText(request)).resolves.toMatchObject({ text: 'b' });
  });
});
