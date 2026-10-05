import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from '@agon/spec';
import { ReplayCache, canonicalJson, computeCacheKey, schemaToJsonSchema } from './cache.js';
import type { LlmRequestDigest } from './cache.js';

const digest: LlmRequestDigest = {
  model: 'anthropic/claude-sonnet-5-5',
  system: 'You are a simulated user.',
  messages: [{ role: 'user', content: 'Page: Welcome. What do you do?' }],
  schema: schemaToJsonSchema(z.object({ action: z.string() })),
  temperature: 0.7,
  maxOutputTokens: 400,
  cacheKey: 'ses_1/step-3',
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('computeCacheKey', () => {
  it('is a stable sha256 hex digest', () => {
    const key = computeCacheKey(digest);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCacheKey({ ...digest })).toBe(key);
    expect(computeCacheKey(JSON.parse(JSON.stringify(digest)) as LlmRequestDigest)).toBe(key);
  });

  it('changes when any request field changes', () => {
    const key = computeCacheKey(digest);
    const variants: LlmRequestDigest[] = [
      { ...digest, model: 'openai/gpt-5' },
      { ...digest, system: 'Other system prompt' },
      { ...digest, messages: [{ role: 'user', content: 'different' }] },
      { ...digest, messages: [{ role: 'assistant', content: digest.messages[0]!.content }] },
      { ...digest, schema: schemaToJsonSchema(z.object({ action: z.number() })) },
      { ...digest, temperature: 0 },
      { ...digest, maxOutputTokens: 401 },
      { ...digest, cacheKey: 'ses_1/step-4' },
    ];
    const keys = new Set(variants.map(computeCacheKey));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(key)).toBe(false);
  });

  it('treats an absent field and an undefined field alike', () => {
    const { cacheKey: _omit, ...withoutKey } = digest;
    expect(computeCacheKey({ ...withoutKey, cacheKey: undefined })).toBe(
      computeCacheKey(withoutKey),
    );
  });
});

describe('schemaToJsonSchema', () => {
  it('produces draft-07 JSON Schema with the object shape', () => {
    const json = schemaToJsonSchema(
      z.object({ action: z.enum(['click', 'done']), reason: z.string().optional() }),
    );
    expect(json['$schema']).toContain('draft-07');
    expect(json).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: { action: { enum: ['click', 'done'] }, reason: { type: 'string' } },
    });
  });
});

describe('ReplayCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agon-llm-cache-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const usage = {
    model: digest.model,
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.00054,
    latencyMs: 812,
    cached: false,
  };

  it('writes one pretty-printed JSON file per key and reads it back', async () => {
    const cache = new ReplayCache(dir);
    const key = computeCacheKey(digest);
    const written = await cache.write(
      key,
      digest,
      { type: 'object', object: { action: 'click' } },
      usage,
    );
    expect(cache.pathFor(key)).toBe(join(dir, `${key}.json`));
    const raw = await readFile(cache.pathFor(key), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(written);
    const entry = await cache.read(key, digest);
    expect(entry).toEqual({
      version: 1,
      key,
      request: digest,
      response: { type: 'object', object: { action: 'click' } },
      usage,
      recordedAt: written.recordedAt,
    });
    expect(Date.parse(entry.recordedAt)).not.toBeNaN();
  });

  it('creates the directory on demand', async () => {
    const nested = join(dir, 'deeper', 'still');
    const cache = new ReplayCache(nested);
    const key = computeCacheKey(digest);
    await cache.write(key, digest, { type: 'text', text: 'hi' }, usage);
    expect((await cache.read(key, digest)).response).toEqual({ type: 'text', text: 'hi' });
  });

  it('reports a miss as an LlmError naming the key, model and path', async () => {
    const cache = new ReplayCache(dir);
    const key = computeCacheKey(digest);
    const promise = cache.read(key, digest);
    await expect(promise).rejects.toBeInstanceOf(LlmError);
    await expect(promise).rejects.toThrow(/replay miss for anthropic\/claude-sonnet-5-5/);
    await expect(promise).rejects.toThrow(key);
    await expect(promise).rejects.toThrow(/AGON_LLM_MODE=record/);
    const error = (await promise.catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('llm_error');
    expect(error.details).toEqual({
      key,
      model: digest.model,
      cacheKey: 'ses_1/step-3',
      path: cache.pathFor(key),
    });
  });

  it('rejects corrupt recordings instead of replaying them', async () => {
    const cache = new ReplayCache(dir);
    const key = computeCacheKey(digest);
    await writeFile(cache.pathFor(key), '{not json', 'utf8');
    await expect(cache.read(key, digest)).rejects.toThrow(/not valid JSON/);
    await writeFile(cache.pathFor(key), JSON.stringify({ version: 2, key }), 'utf8');
    await expect(cache.read(key, digest)).rejects.toThrow(/unexpected shape/);
  });
});
