import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { LlmError, LlmUsageSchema, nowIso } from '@agon/spec';
import type { LlmMessage, LlmUsage, ModelRef } from '@agon/spec';

export const DEFAULT_CACHE_DIR = '.agon/llm-cache';

/** The parts of a request that determine its cache key. `schema` is the JSON Schema form. */
export interface LlmRequestDigest {
  model: ModelRef;
  system: string;
  messages: LlmMessage[];
  schema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  cacheKey?: string;
}

/** JSON with object keys sorted recursively and `undefined` members dropped, for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member !== undefined) out[key] = sortKeys(member);
    }
    return out;
  }
  return value;
}

/** sha256 over the canonical JSON of the digest. */
export function computeCacheKey(digest: LlmRequestDigest): string {
  return createHash('sha256').update(canonicalJson(digest)).digest('hex');
}

/** JSON Schema (draft-07, input view) for a Zod schema, which is also what providers receive. */
export function schemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}

const DigestSchema = z.object({
  model: z.string(),
  system: z.string(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  schema: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().int().optional(),
  cacheKey: z.string().optional(),
});

export const CacheResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('object'), object: z.unknown() }),
  z.object({ type: z.literal('text'), text: z.string() }),
]);
export type CacheResponse = z.infer<typeof CacheResponseSchema>;

/** One recorded call, stored as `<cacheDir>/<key>.json`. */
export const CacheEntrySchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  request: DigestSchema,
  response: CacheResponseSchema,
  usage: LlmUsageSchema,
  recordedAt: z.string(),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

/** File-backed store for recorded responses: one JSON file per request key. */
export class ReplayCache {
  readonly dir: string;

  constructor(dir: string = DEFAULT_CACHE_DIR) {
    this.dir = resolve(dir);
  }

  pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /** Reads a recording. Throws `LlmError` on a miss or a corrupt file. */
  async read(key: string, digest: LlmRequestDigest): Promise<CacheEntry> {
    const path = this.pathFor(key);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const cacheKey = digest.cacheKey === undefined ? '' : ` (cacheKey "${digest.cacheKey}")`;
        throw new LlmError(
          `replay miss for ${digest.model}: no recording ${key} in ${this.dir}${cacheKey}. ` +
            'Run the same scenario with AGON_LLM_MODE=record to create it.',
          { details: { key, model: digest.model, cacheKey: digest.cacheKey, path } },
        );
      }
      throw new LlmError(`failed to read LLM recording ${path}: ${(error as Error).message}`, {
        cause: error,
        details: { key, path },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new LlmError(`LLM recording ${path} is not valid JSON`, {
        cause: error,
        details: { key, path },
      });
    }
    const entry = CacheEntrySchema.safeParse(parsed);
    if (!entry.success) {
      throw new LlmError(
        `LLM recording ${path} has an unexpected shape:\n${z.prettifyError(entry.error)}`,
        { details: { key, path, issues: entry.error.issues } },
      );
    }
    return entry.data;
  }

  /** Writes a recording atomically (temp file + rename), creating the directory if needed. */
  async write(
    key: string,
    digest: LlmRequestDigest,
    response: CacheResponse,
    usage: LlmUsage,
  ): Promise<CacheEntry> {
    const entry: CacheEntry = {
      version: 1,
      key,
      request: digest,
      response,
      usage,
      recordedAt: nowIso(),
    };
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return entry;
  }
}
