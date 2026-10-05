import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetExceededError, ConfigError, LlmError } from '@agon/spec';
import type { LlmObjectRequest, LlmRequestBase } from '@agon/spec';
import { ReplayCache, computeCacheKey, schemaToJsonSchema } from './cache.js';
import { createLlmClient } from './client.js';
import type { LlmClientOptions } from './client.js';
import type { LlmLogger } from './logger.js';
import { mockModel, promptText, textResult } from './testing/mock-model.js';
import type { MockResponder } from './testing/mock-model.js';

/** $2 per 1M input tokens, $10 per 1M output tokens in DEFAULT_PRICING. */
const MODEL = 'anthropic/claude-sonnet-5-5';
const Decision = z.object({ action: z.enum(['click', 'done']), reason: z.string().min(1) });
type Decision = z.infer<typeof Decision>;

const request: LlmRequestBase = {
  model: MODEL,
  system: 'You are a simulated user.',
  messages: [{ role: 'user', content: 'The page shows a Sign up button.' }],
  temperature: 0,
  maxOutputTokens: 200,
  cacheKey: 'ses_1/step-1',
  purpose: 'act',
};
const objectRequest: LlmObjectRequest<Decision> = {
  ...request,
  schema: Decision,
  schemaName: 'Decision',
};

const json = (value: unknown, tokens?: { input?: number; output?: number }) =>
  textResult(JSON.stringify(value), tokens);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function spyLogger(): LlmLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine['level']) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      lines.push({ level, obj, msg });
    };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function liveClient(model: ReturnType<typeof mockModel>, options: LlmClientOptions = {}) {
  return createLlmClient({
    mode: 'live',
    env: {},
    retryBaseDelayMs: 1,
    models: { [MODEL]: model },
    ...options,
  });
}

function apiFailure(statusCode: number, responseHeaders?: Record<string, string>): MockResponder {
  return () => {
    throw new APICallError({
      message: `upstream ${statusCode}`,
      url: 'https://api.anthropic.test/v1/messages',
      requestBodyValues: {},
      statusCode,
      isRetryable: statusCode === 429 || statusCode >= 500,
      responseHeaders,
    });
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('createLlmClient options', () => {
  it('takes the mode from the option, then AGON_LLM_MODE, then defaults to live', () => {
    expect(createLlmClient({ env: {} }).mode).toBe('live');
    expect(createLlmClient({ env: { AGON_LLM_MODE: 'replay' } }).mode).toBe('replay');
    expect(createLlmClient({ env: { AGON_LLM_MODE: 'replay' }, mode: 'record' }).mode).toBe(
      'record',
    );
    expect(createLlmClient({ env: {}, mode: 'off' }).mode).toBe('off');
  });

  it('rejects invalid modes and limits with ConfigError', () => {
    expect(() => createLlmClient({ env: { AGON_LLM_MODE: 'cached' } })).toThrow(ConfigError);
    expect(() => createLlmClient({ env: { AGON_LLM_MODE: 'cached' } })).toThrow(
      /live, record, replay, off/,
    );
    expect(() => createLlmClient({ env: {}, maxConcurrency: 0 })).toThrow(ConfigError);
    expect(() => createLlmClient({ env: {}, retries: -1 })).toThrow(ConfigError);
    expect(() => createLlmClient({ env: {}, maxCostUsd: -5 })).toThrow(ConfigError);
  });

  it('resolves the cache directory to an absolute path, defaulting to .agon/llm-cache', () => {
    const client = createLlmClient({ env: {} });
    expect(isAbsolute(client.cacheDir)).toBe(true);
    expect(client.cacheDir.endsWith(join('.agon', 'llm-cache'))).toBe(true);
    expect(createLlmClient({ env: {}, cacheDir: '/tmp/x' }).cacheDir).toBe('/tmp/x');
  });
});

describe('generateObject', () => {
  it('returns the validated object with provider usage and the computed cost', async () => {
    const model = mockModel([
      json({ action: 'click', reason: 'the button' }, { input: 1000, output: 100 }),
    ]);
    const client = liveClient(model);
    const response = await client.generateObject(objectRequest);
    expect(response.object).toEqual({ action: 'click', reason: 'the button' });
    expect(response.usage).toMatchObject({
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 100,
      cached: false,
    });
    expect(response.usage.costUsd).toBeCloseTo(0.003, 9);
    expect(response.usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(response.usage.latencyMs)).toBe(true);
    expect(client.totalCostUsd).toBeCloseTo(0.003, 9);
    expect(client.totals()).toMatchObject({
      calls: 1,
      cacheHits: 0,
      inputTokens: 1000,
      outputTokens: 100,
    });
  });

  it('sends the system prompt, messages, sampling settings and JSON schema to the provider', async () => {
    const model = mockModel([json({ action: 'done', reason: 'ok' })]);
    await liveClient(model).generateObject(objectRequest);
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0]!;
    expect(call.temperature).toBe(0);
    expect(call.maxOutputTokens).toBe(200);
    expect(call.responseFormat).toMatchObject({
      type: 'json',
      name: 'Decision',
      schema: { type: 'object', required: ['action', 'reason'] },
    });
    const prompt = promptText(call);
    expect(prompt).toContain('You are a simulated user.');
    expect(prompt).toContain('The page shows a Sign up button.');
  });

  it('retries once with the validation error fed back when the object does not match the schema', async () => {
    const logger = spyLogger();
    const model = mockModel([
      json({ action: 'fly', reason: 'x' }),
      json({ action: 'done', reason: 'finished' }),
    ]);
    const response = await liveClient(model, { logger }).generateObject(objectRequest);
    expect(response.object).toEqual({ action: 'done', reason: 'finished' });
    expect(model.doGenerateCalls).toHaveLength(2);

    const retryPrompt = promptText(model.doGenerateCalls[1]!);
    expect(retryPrompt).toContain('Your previous response was rejected');
    expect(retryPrompt).toContain('did not match the schema');
    expect(retryPrompt).toContain('action');
    expect(retryPrompt).toContain('fly');
    expect(retryPrompt).toContain('"role":"assistant"');

    // Both attempts are paid for.
    expect(response.usage.inputTokens).toBe(200);
    expect(response.usage.outputTokens).toBe(40);
    expect(
      logger.lines.filter((l) => l.level === 'warn' && l.msg === 'llm structured output rejected'),
    ).toHaveLength(1);
  });

  it('retries once when the response is not JSON or is empty', async () => {
    const notJson = mockModel([
      textResult('Sure! {"action":"click","reason":"x"}'),
      json({ action: 'click', reason: 'x' }),
    ]);
    await expect(liveClient(notJson).generateObject(objectRequest)).resolves.toMatchObject({
      object: { action: 'click', reason: 'x' },
    });
    expect(promptText(notJson.doGenerateCalls[1]!)).toContain('not valid JSON');

    const empty = mockModel([
      { ...textResult(''), finishReason: { unified: 'length', raw: 'max_tokens' } },
      json({ action: 'done', reason: 'y' }),
    ]);
    await expect(liveClient(empty).generateObject(objectRequest)).resolves.toMatchObject({
      object: { action: 'done', reason: 'y' },
    });
    expect(promptText(empty.doGenerateCalls[1]!)).toContain('returned no output');
  });

  it('throws an LlmError with details after the second invalid output', async () => {
    const model = mockModel([textResult('nonsense'), json({ action: 'nope' })]);
    const client = liveClient(model);
    const error = await rejection(client.generateObject(objectRequest));
    expect(error).toBeInstanceOf(LlmError);
    const llmError = error as LlmError;
    expect(llmError.code).toBe('llm_error');
    expect(llmError.message).toMatch(/did not produce output matching the schema after 2 attempts/);
    expect(llmError.details).toMatchObject({
      model: MODEL,
      attempts: 2,
      reason: expect.stringContaining('did not match the schema'),
      text: '{"action":"nope"}',
      inputTokens: 200,
      outputTokens: 40,
    });
    expect(llmError.cause).toBeInstanceOf(Error);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(client.totals()).toMatchObject({ calls: 0, inputTokens: 200, outputTokens: 40 });
    expect(client.totalCostUsd).toBeCloseTo(0.0008, 9);
  });

  it('applies schema defaults to the returned object', async () => {
    const WithDefault = z.object({ action: z.string(), confidence: z.number().default(0.5) });
    const model = mockModel([json({ action: 'click' })]);
    const { object } = await liveClient(model).generateObject({ ...request, schema: WithDefault });
    expect(object).toEqual({ action: 'click', confidence: 0.5 });
  });

  it('rejects malformed model references before calling anything', async () => {
    const model = mockModel([json({ action: 'done', reason: 'ok' })]);
    const error = await rejection(
      liveClient(model).generateObject({ ...objectRequest, model: 'claude-sonnet-5-5' }),
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain('invalid model reference');
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe('generateText', () => {
  it('returns the text with usage and cost', async () => {
    const model = mockModel([textResult('Hello there', { input: 10, output: 3 })]);
    const client = liveClient(model);
    const response = await client.generateText(request);
    expect(response.text).toBe('Hello there');
    expect(response.usage).toMatchObject({
      model: MODEL,
      inputTokens: 10,
      outputTokens: 3,
      cached: false,
    });
    expect(response.usage.costUsd).toBeCloseTo(0.00005, 12);
    expect(model.doGenerateCalls[0]?.responseFormat).toBeUndefined();
    expect(client.totals()).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 3 });
  });

  it('wraps provider failures in LlmError without retrying client errors', async () => {
    const model = mockModel([apiFailure(400)]);
    const error = await rejection(liveClient(model).generateText(request));
    expect(error).toBeInstanceOf(LlmError);
    const llmError = error as LlmError;
    expect(llmError.message).toContain('HTTP 400');
    expect(llmError.details).toMatchObject({ model: MODEL, statusCode: 400, retryable: false });
    expect(APICallError.isInstance(llmError.cause)).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe('reliability', () => {
  it('retries rate limits and server errors with backoff, then succeeds', async () => {
    const logger = spyLogger();
    const model = mockModel([
      apiFailure(429, { 'retry-after-ms': '1' }),
      apiFailure(503),
      json({ action: 'done', reason: 'ok' }),
    ]);
    const response = await liveClient(model, { retries: 3, logger }).generateObject(objectRequest);
    expect(response.object).toEqual({ action: 'done', reason: 'ok' });
    expect(model.doGenerateCalls).toHaveLength(3);
    const retryLogs = logger.lines.filter((l) => l.msg === 'llm call failed, retrying');
    expect(retryLogs).toHaveLength(2);
    expect(retryLogs[0]?.level).toBe('warn');
    expect(retryLogs[0]?.obj).toMatchObject({
      model: MODEL,
      attempt: 1,
      retries: 3,
      error: { statusCode: 429 },
    });
  });

  it('gives up after the configured number of retries', async () => {
    const model = mockModel([apiFailure(429)]);
    const error = await rejection(liveClient(model, { retries: 1 }).generateText(request));
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain('HTTP 429');
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('caps the number of provider calls in flight', async () => {
    const run = async (maxConcurrency: number) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const model = mockModel([
        async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(15);
          inFlight--;
          return textResult('ok');
        },
      ]);
      const client = liveClient(model, { maxConcurrency });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => client.generateText(request)),
      );
      expect(results.map((r) => r.text)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      expect(model.doGenerateCalls).toHaveLength(5);
      return maxInFlight;
    };
    expect(await run(2)).toBe(2);
    expect(await run(5)).toBe(5);
  });
});

describe('cost accounting', () => {
  it('stops before the call once the running total reaches maxCostUsd', async () => {
    const model = mockModel([json({ action: 'done', reason: 'ok' }, { input: 1000, output: 100 })]);
    const client = liveClient(model, { maxCostUsd: 0.005 });
    await client.generateObject(objectRequest);
    await client.generateObject(objectRequest);
    expect(client.totalCostUsd).toBeCloseTo(0.006, 9);
    const error = await rejection(client.generateObject(objectRequest));
    expect(error).toBeInstanceOf(BudgetExceededError);
    const budget = error as BudgetExceededError;
    expect(budget.code).toBe('budget_exceeded');
    expect(budget.details).toMatchObject({ what: 'LLM spend (USD)', limit: 0.005 });
    expect((budget.details as { actual: number }).actual).toBeCloseTo(0.006, 9);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('allows no live calls at all when the budget is zero', async () => {
    const model = mockModel([textResult('never')]);
    await expect(liveClient(model, { maxCostUsd: 0 }).generateText(request)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('records unknown models at zero cost and warns once per model', async () => {
    const logger = spyLogger();
    const ref = 'local/llama3';
    const model = mockModel([textResult('ok', { input: 500, output: 50 })]);
    const client = createLlmClient({ mode: 'live', env: {}, models: { [ref]: model }, logger });
    expect(client.isPriced(ref)).toBe(false);
    expect(client.isPriced(MODEL)).toBe(true);
    const first = await client.generateText({ ...request, model: ref });
    const second = await client.generateText({ ...request, model: ref });
    expect(first.usage.costUsd).toBe(0);
    expect(second.usage.costUsd).toBe(0);
    expect(client.totals()).toMatchObject({
      calls: 2,
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 0,
    });
    const warnings = logger.lines.filter(
      (l) => l.level === 'warn' && /no pricing/.test(l.msg ?? ''),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toEqual({ model: ref });
  });

  it('merges custom pricing over the defaults', async () => {
    const ref = 'local/llama3';
    const model = mockModel([textResult('ok', { input: 1_000_000, output: 1_000_000 })]);
    const client = createLlmClient({
      mode: 'live',
      env: {},
      models: { [ref]: model },
      pricing: { [ref]: { inputPerMillion: 0.1, outputPerMillion: 0.2 } },
    });
    expect(client.isPriced(ref)).toBe(true);
    const { usage } = await client.generateText({ ...request, model: ref });
    expect(usage.costUsd).toBeCloseTo(0.3, 9);
  });

  it('logs every completed call with its usage', async () => {
    const logger = spyLogger();
    const model = mockModel([json({ action: 'done', reason: 'ok' }, { input: 10, output: 5 })]);
    await liveClient(model, { logger }).generateObject(objectRequest);
    const line = logger.lines.find((l) => l.msg === 'llm call');
    expect(line?.level).toBe('info');
    expect(line?.obj).toMatchObject({
      model: MODEL,
      kind: 'object',
      purpose: 'act',
      inputTokens: 10,
      outputTokens: 5,
      cached: false,
    });
  });
});

describe('record and replay', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agon-llm-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const expectedDigest = {
    model: MODEL,
    system: request.system,
    messages: request.messages,
    schema: schemaToJsonSchema(Decision),
    temperature: 0,
    maxOutputTokens: 200,
    cacheKey: 'ses_1/step-1',
  };

  it('records live object responses under the documented key and replays them without a provider', async () => {
    const recorder = createLlmClient({
      mode: 'record',
      cacheDir: dir,
      env: {},
      models: {
        [MODEL]: mockModel([
          json({ action: 'click', reason: 'recorded' }, { input: 50, output: 7 }),
        ]),
      },
    });
    const live = await recorder.generateObject(objectRequest);
    expect(live.usage.cached).toBe(false);

    const key = computeCacheKey(expectedDigest);
    expect(await readdir(dir)).toEqual([`${key}.json`]);
    const entry = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      version: 1,
      key,
      request: expectedDigest,
      response: { type: 'object', object: { action: 'click', reason: 'recorded' } },
      usage: { model: MODEL, inputTokens: 50, outputTokens: 7, cached: false },
    });

    const untouched = mockModel([textResult('should not be called')]);
    const replayer = createLlmClient({
      mode: 'replay',
      cacheDir: dir,
      env: {},
      models: { [MODEL]: untouched },
    });
    const replayed = await replayer.generateObject(objectRequest);
    expect(replayed.object).toEqual(live.object);
    expect(replayed.usage).toEqual({
      model: MODEL,
      inputTokens: 50,
      outputTokens: 7,
      costUsd: 0,
      latencyMs: 0,
      cached: true,
    });
    expect(untouched.doGenerateCalls).toHaveLength(0);
    expect(replayer.totals()).toEqual({
      calls: 1,
      cacheHits: 1,
      inputTokens: 50,
      outputTokens: 7,
      costUsd: 0,
    });
    expect(replayer.totalCostUsd).toBe(0);

    // A replay client needs no credentials at all.
    const bare = createLlmClient({ mode: 'replay', cacheDir: dir, env: {} });
    await expect(bare.generateObject(objectRequest)).resolves.toMatchObject({
      object: live.object,
    });
  });

  it('stores the raw model output so replays go through the schema again', async () => {
    const WithDefault = z.object({ action: z.string(), confidence: z.number().default(0.5) });
    const recorder = createLlmClient({
      mode: 'record',
      cacheDir: dir,
      env: {},
      models: { [MODEL]: mockModel([json({ action: 'click' })]) },
    });
    const live = await recorder.generateObject({ ...request, schema: WithDefault });
    expect(live.object).toEqual({ action: 'click', confidence: 0.5 });
    const [file] = await readdir(dir);
    const entry = JSON.parse(await readFile(join(dir, file!), 'utf8')) as { response: unknown };
    expect(entry.response).toEqual({ type: 'object', object: { action: 'click' } });

    const replayer = createLlmClient({ mode: 'replay', cacheDir: dir, env: {} });
    await expect(
      replayer.generateObject({ ...request, schema: WithDefault }),
    ).resolves.toMatchObject({
      object: { action: 'click', confidence: 0.5 },
    });
  });

  it('records and replays text responses', async () => {
    const recorder = createLlmClient({
      mode: 'record',
      cacheDir: dir,
      env: {},
      models: { [MODEL]: mockModel([textResult('verdict: success', { input: 20, output: 4 })]) },
    });
    await recorder.generateText(request);
    const replayer = createLlmClient({ mode: 'replay', cacheDir: dir, env: {} });
    const replayed = await replayer.generateText(request);
    expect(replayed.text).toBe('verdict: success');
    expect(replayed.usage).toEqual({
      model: MODEL,
      inputTokens: 20,
      outputTokens: 4,
      costUsd: 0,
      latencyMs: 0,
      cached: true,
    });
  });

  it('fails a replay miss with an LlmError that names the key and model', async () => {
    const recorder = createLlmClient({
      mode: 'record',
      cacheDir: dir,
      env: {},
      models: { [MODEL]: mockModel([json({ action: 'done', reason: 'ok' })]) },
    });
    await recorder.generateObject(objectRequest);

    const replayer = createLlmClient({ mode: 'replay', cacheDir: dir, env: {} });
    const error = await rejection(
      replayer.generateObject({ ...objectRequest, cacheKey: 'ses_1/step-2' }),
    );
    expect(error).toBeInstanceOf(LlmError);
    const llmError = error as LlmError;
    const details = llmError.details as {
      key: string;
      model: string;
      cacheKey: string;
      path: string;
    };
    expect(details.key).toMatch(/^[0-9a-f]{64}$/);
    expect(details.key).toBe(computeCacheKey({ ...expectedDigest, cacheKey: 'ses_1/step-2' }));
    expect(details).toMatchObject({
      model: MODEL,
      cacheKey: 'ses_1/step-2',
      path: join(dir, `${details.key}.json`),
    });
    expect(llmError.message).toContain('replay miss');
    expect(llmError.message).toContain(MODEL);
    expect(llmError.message).toContain(details.key);

    // Any change to the prompt, model or schema is a different recording.
    await expect(
      replayer.generateObject({ ...objectRequest, model: 'openai/gpt-5' }),
    ).rejects.toThrow(/replay miss/);
    await expect(replayer.generateObject({ ...objectRequest, temperature: 0.5 })).rejects.toThrow(
      /replay miss/,
    );
    await expect(replayer.generateText(request)).rejects.toThrow(/replay miss/);
  });

  it('refuses to replay a recording of the other kind under the same key', async () => {
    const key = computeCacheKey(expectedDigest);
    await new ReplayCache(dir).write(
      key,
      expectedDigest,
      { type: 'text', text: 'wrong kind' },
      {
        model: MODEL,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 0,
        cached: false,
      },
    );
    const replayer = createLlmClient({ mode: 'replay', cacheDir: dir, env: {} });
    await expect(replayer.generateObject(objectRequest)).rejects.toThrow(
      /holds a text response but the request expects object/,
    );
  });

  it('never touches the cache directory in live or off mode', async () => {
    for (const mode of ['live', 'off'] as const) {
      const client = createLlmClient({
        mode,
        cacheDir: dir,
        env: {},
        models: { [MODEL]: mockModel([json({ action: 'done', reason: 'ok' })]) },
      });
      const response = await client.generateObject(objectRequest);
      expect(response.usage.cached).toBe(false);
    }
    expect(await readdir(dir)).toEqual([]);
  });
});
