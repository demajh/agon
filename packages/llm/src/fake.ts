import { z } from 'zod';
import { LlmError, LlmUsageSchema } from '@agon/spec';
import type {
  LlmClient,
  LlmMessage,
  LlmObjectRequest,
  LlmObjectResponse,
  LlmPurpose,
  LlmRequestBase,
  LlmTextResponse,
  LlmUsage,
  ModelRef,
} from '@agon/spec';
import { DEFAULT_PRICING, computeCostUsd, estimateTokens } from './pricing.js';
import type { PricingTable } from './pricing.js';

/** One request seen by a `FakeLlmClient`, kept for assertions. */
export interface FakeLlmCall {
  /** 1-based position in `calls`. */
  index: number;
  kind: 'object' | 'text';
  model: ModelRef;
  system: string;
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  cacheKey?: string;
  purpose?: LlmPurpose;
  /** Only for `generateObject` calls. */
  schemaName?: string;
  /** Only for `generateObject` calls. */
  schema?: z.ZodType;
}

/**
 * An object for `generateObject` (validated against the request schema) or a string for
 * `generateText`. Deliberately not `unknown`, so that a handler placed in a scripted queue keeps
 * its contextual parameter type.
 */
export type FakeLlmResponse = string | number | boolean | null | object;
export type FakeLlmHandler = (call: FakeLlmCall) => FakeLlmResponse | Promise<FakeLlmResponse>;

export interface FakeLlmClientOptions {
  /** Prices for the fake usage report (default `DEFAULT_PRICING`). */
  pricing?: PricingTable;
  /** Latency reported on every call (default 0). */
  latencyMs?: number;
}

/**
 * Deterministic, offline `LlmClient` for other packages' tests. Responses come from a handler
 * function or a queue of scripted responses (a function in the queue is invoked for that call).
 * Objects are validated against the request schema so a test fails at the fake, not deep in the
 * engine. Usage is estimated from character counts and priced with the pricing table.
 */
export class FakeLlmClient implements LlmClient {
  readonly calls: FakeLlmCall[] = [];
  private readonly handler: FakeLlmHandler | undefined;
  private readonly queue: Array<FakeLlmResponse | FakeLlmHandler> | undefined;
  private readonly pricing: PricingTable;
  private readonly latencyMs: number;
  private costUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    script: FakeLlmHandler | ReadonlyArray<FakeLlmResponse | FakeLlmHandler>,
    options: FakeLlmClientOptions = {},
  ) {
    if (typeof script === 'function') {
      this.handler = script;
    } else {
      this.queue = [...script];
    }
    this.pricing = options.pricing ?? DEFAULT_PRICING;
    this.latencyMs = options.latencyMs ?? 0;
  }

  /** USD attributed to all calls so far (0 for models missing from the pricing table). */
  get totalCostUsd(): number {
    return this.costUsd;
  }

  /** Scripted responses not yet consumed; `undefined` in handler mode. */
  get remaining(): number | undefined {
    return this.queue?.length;
  }

  totals(): { calls: number; inputTokens: number; outputTokens: number; costUsd: number } {
    return {
      calls: this.calls.length,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
  }

  /** Forgets recorded calls and totals. Scripted responses that are still queued stay queued. */
  reset(): void {
    this.calls.length = 0;
    this.costUsd = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResponse<T>> {
    const call = this.remember('object', request, request.schema, request.schemaName);
    const response = await this.next(call);
    const parsed = request.schema.safeParse(response);
    if (!parsed.success) {
      throw new LlmError(
        `FakeLlmClient: scripted response for call #${call.index} (${request.model}) does not match the request schema:\n${z.prettifyError(parsed.error)}`,
        {
          details: {
            call: call.index,
            model: request.model,
            issues: parsed.error.issues,
            response,
          },
        },
      );
    }
    return { object: parsed.data, usage: this.usage(call, JSON.stringify(parsed.data) ?? '') };
  }

  async generateText(request: LlmRequestBase): Promise<LlmTextResponse> {
    const call = this.remember('text', request);
    const response = await this.next(call);
    const text = typeof response === 'string' ? response : (JSON.stringify(response) ?? '');
    return { text, usage: this.usage(call, text) };
  }

  private remember(
    kind: FakeLlmCall['kind'],
    request: LlmRequestBase,
    schema?: z.ZodType,
    schemaName?: string,
  ): FakeLlmCall {
    const call: FakeLlmCall = {
      index: this.calls.length + 1,
      kind,
      model: request.model,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.temperature !== undefined) call.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) call.maxOutputTokens = request.maxOutputTokens;
    if (request.cacheKey !== undefined) call.cacheKey = request.cacheKey;
    if (request.purpose !== undefined) call.purpose = request.purpose;
    if (schema !== undefined) call.schema = schema;
    if (schemaName !== undefined) call.schemaName = schemaName;
    this.calls.push(call);
    return call;
  }

  private async next(call: FakeLlmCall): Promise<FakeLlmResponse> {
    if (this.handler) return this.handler(call);
    const scripted = this.queue?.shift();
    if (scripted === undefined) {
      throw new LlmError(
        `FakeLlmClient: no scripted response left for call #${call.index} (${call.kind} on ${call.model})`,
        { details: { call: call.index, kind: call.kind, model: call.model } },
      );
    }
    return typeof scripted === 'function' ? (scripted as FakeLlmHandler)(call) : scripted;
  }

  private usage(call: FakeLlmCall, outputText: string): LlmUsage {
    const promptText = [call.system, ...call.messages.map((m) => m.content)].join('\n');
    const inputTokens = estimateTokens(promptText);
    const outputTokens = estimateTokens(outputText);
    const costUsd = computeCostUsd(call.model, inputTokens, outputTokens, this.pricing) ?? 0;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.costUsd += costUsd;
    return LlmUsageSchema.parse({
      model: call.model,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: this.latencyMs,
      cached: false,
    });
  }
}
