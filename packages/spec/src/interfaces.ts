import type { z } from 'zod';
import type { ModelRef } from './common.js';
import type { AgonEvent, EventDraft } from './event.js';
import type { LedgerEntry } from './ledger.js';
import type { Device } from './persona.js';
import type { Run } from './run.js';
import type { Result } from './result.js';
import type { ActResult, Action, LlmUsage, Observation, Session, Step } from './session.js';
import type { Capture, TargetKind, VariantSpec } from './target.js';

// ---------------------------------------------------------------------------
// Adapter: how the engine drives a target. Implemented in @agon/adapters.
// ---------------------------------------------------------------------------

export interface OpenOptions {
  sessionId: string;
  variant: string;
  startPath: string;
  viewport: { width: number; height: number };
  device: Device;
  locale: string;
  capture: Capture;
  /** Output of the session setup hook, e.g. test-account credentials. */
  credentials?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ObserveOptions {
  /** Cap on interactive elements returned; the adapter keeps the earliest in reading order. */
  maxInteractive?: number;
  /** Cap on readable text characters. */
  maxTextChars?: number;
  screenshot?: boolean;
}

export interface AdapterSession {
  readonly kind: TargetKind;
  observe(options?: ObserveOptions): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  /** Returns and clears events captured since the last call (intercepted analytics, errors). */
  drainEvents(): EventDraft[];
  screenshot(): Promise<Uint8Array | undefined>;
  close(): Promise<void>;
}

export interface Adapter {
  readonly kind: TargetKind;
  open(variant: VariantSpec, options: OpenOptions): Promise<AdapterSession>;
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// LLM client: the only way any package talks to a model. Implemented in @agon/llm.
// ---------------------------------------------------------------------------

export type LlmPurpose = 'act' | 'judge' | 'persona' | 'other';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequestBase {
  model: ModelRef;
  system: string;
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Extra discriminator mixed into the record/replay cache key. In record and replay modes the
   * cache covers every request (keyed on model, prompts, schema and sampling parameters); this
   * field lets callers separate requests that would otherwise look identical.
   */
  cacheKey?: string;
  purpose?: LlmPurpose;
}

export interface LlmObjectRequest<T> extends LlmRequestBase {
  schema: z.ZodType<T>;
  schemaName?: string;
}

export interface LlmObjectResponse<T> {
  object: T;
  usage: LlmUsage;
}

export interface LlmTextResponse {
  text: string;
  usage: LlmUsage;
}

export interface LlmClient {
  generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResponse<T>>;
  generateText(request: LlmRequestBase): Promise<LlmTextResponse>;
}

// ---------------------------------------------------------------------------
// Recorder: where the engine writes what happened. Implemented by server and cli.
// ---------------------------------------------------------------------------

export interface Recorder {
  runStarted(run: Run): Promise<void>;
  sessionStarted(session: Session): Promise<void>;
  step(step: Step, screenshot?: Uint8Array): Promise<void>;
  events(events: AgonEvent[]): Promise<void>;
  sessionFinished(session: Session): Promise<void>;
  runFinished(run: Run, result?: Result): Promise<void>;
}

// ---------------------------------------------------------------------------
// Evaluation ledger: append-only trial counter keyed by sample hash. The engine's FileLedger
// (JSONL) and @agon/db's createDbLedger implement it.
// ---------------------------------------------------------------------------

export interface EvaluationLedger {
  /** Appends one entry; entries are never updated or removed. */
  append(entry: LedgerEntry): Promise<void>;
  /** Every entry recorded against a sample, in insertion order. */
  list(sampleHash: string): Promise<LedgerEntry[]>;
}
