import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  generateText,
} from 'ai';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { z } from 'zod';
import { AgonError, BudgetExceededError, ConfigError, LlmError, LlmUsageSchema } from '@agon/spec';
import type {
  LlmClient,
  LlmMessage,
  LlmObjectRequest,
  LlmObjectResponse,
  LlmRequestBase,
  LlmTextResponse,
  LlmUsage,
  ModelRef,
} from '@agon/spec';
import { DEFAULT_CACHE_DIR, ReplayCache, computeCacheKey, schemaToJsonSchema } from './cache.js';
import type { CacheEntry, LlmRequestDigest } from './cache.js';
import { Semaphore } from './limiter.js';
import { errorSummary, noopLogger } from './logger.js';
import type { LlmLogger } from './logger.js';
import { DEFAULT_PRICING, computeCostUsd, isPriced } from './pricing.js';
import type { PricingTable } from './pricing.js';
import { ModelRouter, assertModelRef, providerSettingsFromEnv } from './routing.js';
import type { LanguageModelInstance, LlmProviderSettings } from './routing.js';
import { withRetry } from './retry.js';

export const LLM_MODES = ['live', 'record', 'replay', 'off'] as const;
export type LlmMode = (typeof LLM_MODES)[number];
const LlmModeSchema = z.enum(LLM_MODES);

export const LLM_MODE_ENV_VAR = 'AGON_LLM_MODE';

export interface LlmClientOptions {
  /**
   * `live` calls providers; `record` calls providers and writes every response to `cacheDir`;
   * `replay` serves recordings only and never touches a provider; `off` behaves like `live`
   * (cache disabled). Default: `AGON_LLM_MODE`, else `live`.
   */
  mode?: LlmMode;
  /** Directory holding recordings (default `.agon/llm-cache`, relative to the working directory). */
  cacheDir?: string;
  /**
   * Provider credentials, merged over the environment defaults `ANTHROPIC_API_KEY`,
   * `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY`.
   */
  providers?: LlmProviderSettings;
  /** Pre-built model instances keyed by ModelRef, used instead of provider routing (tests, custom providers). */
  models?: Record<string, LanguageModelInstance>;
  /** Extra or corrected prices (USD per 1M tokens), merged over `DEFAULT_PRICING`. */
  pricing?: PricingTable;
  /** Hard stop: once this client's spend reaches the limit, further live calls throw `BudgetExceededError`. */
  maxCostUsd?: number;
  /** Provider calls allowed in flight at once (default 8). */
  maxConcurrency?: number;
  /** Retries on rate limits, 5xx responses and network errors (default 3). */
  retries?: number;
  /** First backoff delay in milliseconds (default 500; doubles on each retry, honours retry-after). */
  retryBaseDelayMs?: number;
  /** pino-compatible logger; the client is silent without one. */
  logger?: LlmLogger;
  /** Environment to read defaults from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

export interface LlmUsageTotals {
  /** Completed requests, replayed ones included. */
  calls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  /** USD spent on live calls; replays and unpriced models add nothing. */
  costUsd: number;
}

export interface AgonLlmClient extends LlmClient {
  readonly mode: LlmMode;
  /** Absolute path of the recording directory. */
  readonly cacheDir: string;
  /** Running total of USD spent by this client. */
  readonly totalCostUsd: number;
  totals(): LlmUsageTotals;
  /** The AI SDK model a reference routes to; throws `LlmError` if the provider is unknown or unconfigured. */
  resolveModel(model: ModelRef): LanguageModelInstance;
  isPriced(model: ModelRef): boolean;
}

export function createLlmClient(options: LlmClientOptions = {}): AgonLlmClient {
  return new DefaultLlmClient(options);
}

/** Attempts at structured output: the first call plus one retry that feeds the validation error back. */
const OUTPUT_ATTEMPTS = 2;
const DETAIL_TEXT_LIMIT = 2_000;

type Kind = 'object' | 'text';

interface TokenCount {
  input: number;
  output: number;
}

interface OutputFailure {
  reason: string;
  text: string | undefined;
  usage: LanguageModelUsage | undefined;
  cause: Error;
}

class DefaultLlmClient implements AgonLlmClient {
  readonly mode: LlmMode;
  readonly cacheDir: string;
  private readonly cache: ReplayCache;
  private readonly router: ModelRouter;
  private readonly pricing: PricingTable;
  private readonly maxCostUsd: number | undefined;
  private readonly limiter: Semaphore;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly log: LlmLogger;
  private readonly unpricedWarned = new Set<string>();
  private readonly tally: LlmUsageTotals = {
    calls: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  constructor(options: LlmClientOptions) {
    const env = options.env ?? process.env;
    this.mode = resolveMode(options.mode, env);
    this.cache = new ReplayCache(options.cacheDir ?? DEFAULT_CACHE_DIR);
    this.cacheDir = this.cache.dir;
    this.router = new ModelRouter(
      { ...providerSettingsFromEnv(env), ...options.providers },
      options.models,
    );
    this.pricing = { ...DEFAULT_PRICING, ...options.pricing };
    this.maxCostUsd = optionalNonNegative('maxCostUsd', options.maxCostUsd);
    this.limiter = new Semaphore(positiveInt('maxConcurrency', options.maxConcurrency ?? 8));
    this.retries = nonNegativeInt('retries', options.retries ?? 3);
    this.retryBaseDelayMs =
      optionalNonNegative('retryBaseDelayMs', options.retryBaseDelayMs) ?? 500;
    this.log = options.logger ?? noopLogger;
  }

  get totalCostUsd(): number {
    return this.tally.costUsd;
  }

  totals(): LlmUsageTotals {
    return { ...this.tally };
  }

  isPriced(model: ModelRef): boolean {
    return isPriced(model, this.pricing);
  }

  resolveModel(model: ModelRef): LanguageModelInstance {
    return this.router.resolve(assertModelRef(model));
  }

  async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResponse<T>> {
    const model = assertModelRef(request.model);
    const digest = toDigest(request, model, schemaToJsonSchema(request.schema));
    this.log.debug({ model, purpose: request.purpose, kind: 'object' }, 'llm request');

    if (this.mode === 'replay') {
      const key = computeCacheKey(digest);
      const entry = await this.cache.read(key, digest);
      if (entry.response.type !== 'object') throw recordingMismatch(key, model, 'object', entry);
      const parsed = request.schema.safeParse(entry.response.object);
      if (!parsed.success) {
        throw new LlmError(
          `recording ${key} for ${model} no longer satisfies the request schema:\n${z.prettifyError(parsed.error)}`,
          { details: { key, model, issues: parsed.error.issues } },
        );
      }
      return { object: parsed.data, usage: this.replayed(entry, model, request, key) };
    }

    const started = performance.now();
    const outcome = await this.generateObjectLive(request, model);
    const usage = this.finish(model, request, 'object', outcome.tokens, outcome.costUsd, started);
    if (this.mode === 'record') {
      await this.record(digest, { type: 'object', object: outcome.raw }, usage);
    }
    return { object: outcome.object, usage };
  }

  async generateText(request: LlmRequestBase): Promise<LlmTextResponse> {
    const model = assertModelRef(request.model);
    const digest = toDigest(request, model);
    this.log.debug({ model, purpose: request.purpose, kind: 'text' }, 'llm request');

    if (this.mode === 'replay') {
      const key = computeCacheKey(digest);
      const entry = await this.cache.read(key, digest);
      if (entry.response.type !== 'text') throw recordingMismatch(key, model, 'text', entry);
      return { text: entry.response.text, usage: this.replayed(entry, model, request, key) };
    }

    const started = performance.now();
    const instance = this.router.resolve(model);
    const tokens: TokenCount = { input: 0, output: 0 };
    const result = await this.invoke(model, request, () =>
      generateText({
        model: instance,
        ...callSettings(request),
        messages: toModelMessages(request.messages),
      }),
    ).catch((error: unknown) => {
      throw this.toLlmError(error, model);
    });
    const costUsd = this.account(model, tokens, result.usage);
    const usage = this.finish(model, request, 'text', tokens, costUsd, started);
    if (this.mode === 'record') {
      await this.record(digest, { type: 'text', text: result.text }, usage);
    }
    return { text: result.text, usage };
  }

  private async generateObjectLive<T>(
    request: LlmObjectRequest<T>,
    model: ModelRef,
  ): Promise<{ object: T; raw: unknown; tokens: TokenCount; costUsd: number }> {
    const instance = this.router.resolve(model);
    const output = Output.object({
      schema: request.schema,
      ...(request.schemaName ? { name: request.schemaName } : {}),
    });
    let messages = toModelMessages(request.messages);
    const tokens: TokenCount = { input: 0, output: 0 };
    let costUsd = 0;
    let failure: OutputFailure | undefined;

    for (let attempt = 1; attempt <= OUTPUT_ATTEMPTS; attempt++) {
      try {
        const result = await this.invoke(model, request, () =>
          generateText({ model: instance, ...callSettings(request), messages, output }),
        );
        costUsd += this.account(model, tokens, result.usage);
        // Throws NoOutputGeneratedError when the model produced nothing to parse.
        const object = result.output;
        return { object, raw: parseJson(result.text) ?? object, tokens, costUsd };
      } catch (error) {
        failure = describeOutputFailure(error);
        if (!failure) throw this.toLlmError(error, model);
        if (failure.usage) costUsd += this.account(model, tokens, failure.usage);
        this.log.warn(
          { model, purpose: request.purpose, attempt, reason: failure.reason },
          'llm structured output rejected',
        );
        if (attempt < OUTPUT_ATTEMPTS) messages = withFeedback(messages, failure);
      }
    }

    const reason = failure?.reason ?? 'unknown failure';
    throw new LlmError(
      `${model} did not produce output matching the schema after ${OUTPUT_ATTEMPTS} attempts: ${reason}`,
      {
        details: {
          model,
          attempts: OUTPUT_ATTEMPTS,
          reason,
          text: truncate(failure?.text),
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          costUsd,
        },
        cause: failure?.cause,
      },
    );
  }

  /** Budget guard, concurrency limit and transport retries around one provider call. */
  private invoke<R>(model: ModelRef, request: LlmRequestBase, call: () => Promise<R>): Promise<R> {
    return this.limiter.run(() => {
      this.assertBudget();
      return withRetry(call, {
        retries: this.retries,
        baseDelayMs: this.retryBaseDelayMs,
        onRetry: ({ attempt, retries, delayMs, error }) =>
          this.log.warn(
            {
              model,
              purpose: request.purpose,
              attempt,
              retries,
              delayMs,
              error: errorSummary(error),
            },
            'llm call failed, retrying',
          ),
      });
    });
  }

  private assertBudget(): void {
    if (this.maxCostUsd !== undefined && this.tally.costUsd >= this.maxCostUsd) {
      throw new BudgetExceededError('LLM spend (USD)', this.maxCostUsd, this.tally.costUsd);
    }
  }

  /** Adds one provider response to the running totals; returns its cost in USD. */
  private account(model: ModelRef, tokens: TokenCount, usage: LanguageModelUsage): number {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    tokens.input += input;
    tokens.output += output;
    const cost = computeCostUsd(model, input, output, this.pricing);
    if (cost === undefined && !this.unpricedWarned.has(model)) {
      this.unpricedWarned.add(model);
      this.log.warn(
        { model },
        'no pricing for model; its cost is recorded as 0 (extend it via createLlmClient({ pricing }))',
      );
    }
    const costUsd = cost ?? 0;
    this.tally.inputTokens += input;
    this.tally.outputTokens += output;
    this.tally.costUsd += costUsd;
    return costUsd;
  }

  private finish(
    model: ModelRef,
    request: LlmRequestBase,
    kind: Kind,
    tokens: TokenCount,
    costUsd: number,
    started: number,
  ): LlmUsage {
    const usage = LlmUsageSchema.parse({
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      costUsd,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      cached: false,
    });
    this.tally.calls++;
    this.log.info(
      { ...usage, kind, purpose: request.purpose, totalCostUsd: this.tally.costUsd },
      'llm call',
    );
    return usage;
  }

  private replayed(
    entry: CacheEntry,
    model: ModelRef,
    request: LlmRequestBase,
    key: string,
  ): LlmUsage {
    const usage = LlmUsageSchema.parse({
      model,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      costUsd: 0,
      latencyMs: 0,
      cached: true,
    });
    this.tally.calls++;
    this.tally.cacheHits++;
    this.tally.inputTokens += usage.inputTokens;
    this.tally.outputTokens += usage.outputTokens;
    this.log.debug(
      {
        model,
        purpose: request.purpose,
        key,
        kind: entry.response.type,
        recordedAt: entry.recordedAt,
      },
      'llm replay',
    );
    return usage;
  }

  private async record(
    digest: LlmRequestDigest,
    response: { type: 'object'; object: unknown } | { type: 'text'; text: string },
    usage: LlmUsage,
  ): Promise<void> {
    const key = computeCacheKey(digest);
    await this.cache.write(key, digest, response, usage);
    this.log.debug({ model: digest.model, key, path: this.cache.pathFor(key) }, 'llm recorded');
  }

  private toLlmError(error: unknown, model: ModelRef): AgonError {
    if (error instanceof AgonError) return error;
    if (RetryError.isInstance(error) && error.lastError !== error) {
      return this.toLlmError(error.lastError, model);
    }
    if (APICallError.isInstance(error)) {
      const status = error.statusCode;
      return new LlmError(
        `${model} request failed${status === undefined ? '' : ` with HTTP ${status}`}: ${error.message}`,
        {
          details: {
            model,
            statusCode: status,
            url: error.url,
            retryable: error.isRetryable,
            responseBody: truncate(error.responseBody),
          },
          cause: error,
        },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new LlmError(`${model} call failed: ${message}`, {
      details: { model, ...errorSummary(error) },
      cause: error,
    });
  }
}

function resolveMode(
  explicit: LlmMode | undefined,
  env: Record<string, string | undefined>,
): LlmMode {
  const raw = explicit ?? env[LLM_MODE_ENV_VAR] ?? 'live';
  const parsed = LlmModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid LLM mode "${raw}": expected one of ${LLM_MODES.join(', ')} (set ${LLM_MODE_ENV_VAR} or pass mode)`,
      { mode: raw },
    );
  }
  return parsed.data;
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${value}`, { [name]: value });
  }
  return value;
}

function nonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${value}`, {
      [name]: value,
    });
  }
  return value;
}

function optionalNonNegative(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got ${value}`, { [name]: value });
  }
  return value;
}

function toDigest(
  request: LlmRequestBase,
  model: ModelRef,
  schema?: Record<string, unknown>,
): LlmRequestDigest {
  const digest: LlmRequestDigest = {
    model,
    system: request.system,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (schema !== undefined) digest.schema = schema;
  if (request.temperature !== undefined) digest.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) digest.maxOutputTokens = request.maxOutputTokens;
  if (request.cacheKey !== undefined) digest.cacheKey = request.cacheKey;
  return digest;
}

function callSettings(request: LlmRequestBase): {
  system: string | undefined;
  temperature: number | undefined;
  maxOutputTokens: number | undefined;
  maxRetries: number;
} {
  return {
    system: request.system === '' ? undefined : request.system,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    // Retries (with backoff and logging) are handled by this client, not by the SDK.
    maxRetries: 0,
  };
}

function toModelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.content },
  );
}

function withFeedback(messages: ModelMessage[], failure: OutputFailure): ModelMessage[] {
  const echo: ModelMessage[] = failure.text ? [{ role: 'assistant', content: failure.text }] : [];
  return [
    ...messages,
    ...echo,
    {
      role: 'user',
      content:
        `Your previous response was rejected: ${failure.reason}\n\n` +
        'Respond again with only a JSON object that satisfies the required schema, with no text outside the JSON.',
    },
  ];
}

/** Recognises the AI SDK errors that mean "the model answered, but not with a valid object". */
function describeOutputFailure(error: unknown): OutputFailure | undefined {
  if (NoObjectGeneratedError.isInstance(error)) {
    const cause = error.cause;
    let reason: string;
    if (TypeValidationError.isInstance(cause)) {
      reason = `the response did not match the schema:\n${formatIssues(cause.cause)}`;
    } else if (JSONParseError.isInstance(cause)) {
      reason = `the response was not valid JSON (${cause.message})`;
    } else {
      reason = error.message;
    }
    return { reason, text: error.text, usage: error.usage, cause: error };
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    return {
      reason: 'the model returned no output',
      text: undefined,
      usage: undefined,
      cause: error,
    };
  }
  return undefined;
}

function formatIssues(cause: unknown): string {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    Array.isArray((cause as { issues?: unknown }).issues)
  ) {
    return z.prettifyError(cause as Parameters<typeof z.prettifyError>[0]);
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function recordingMismatch(
  key: string,
  model: ModelRef,
  expected: Kind,
  entry: CacheEntry,
): LlmError {
  return new LlmError(
    `recording ${key} for ${model} holds a ${entry.response.type} response but the request expects ${expected}`,
    { details: { key, model, expected, actual: entry.response.type } },
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function truncate(text: string | undefined, limit = DETAIL_TEXT_LIMIT): string | undefined {
  if (text === undefined) return undefined;
  return text.length > limit
    ? `${text.slice(0, limit)}… [${text.length - limit} more chars]`
    : text;
}
