import type {
  AgonEvent,
  ExportConfig,
  Result,
  Run,
  Session,
  SimProperties,
  Step,
} from '@agon/spec';
import { AgonError, ErrorCodes, SimPropertiesSchema, assertSimulated, nowIso } from '@agon/spec';

/**
 * A sink for everything a run produces. The engine (through the server or the CLI) calls these
 * in lifecycle order: `runStarted`, then any mix of `steps` / `events` / `sessionFinished`
 * (possibly concurrently across sessions), then `runFinished`, then `close`.
 *
 * Every implementation refuses events without simulation markers (CLAUDE.md invariant 5):
 * `events()` calls `assertSimulated` on each event before anything is written or sent, so
 * nothing that could pass for real traffic ever leaves the process.
 */
export interface Exporter {
  readonly name: string;
  runStarted(run: Run): Promise<void>;
  sessionFinished(session: Session): Promise<void>;
  steps(steps: Step[]): Promise<void>;
  events(events: AgonEvent[]): Promise<void>;
  runFinished(run: Run, result?: Result): Promise<void>;
  /** Flushes and releases resources. Network sinks surface the failures they collected here. */
  close(): Promise<void>;
}

/** Structural logger; a pino `Logger` satisfies it. */
export interface ExporterLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ExporterContext {
  runId: string;
  /** `agon.yaml` name; used as `experiment_key` in the exposures table. */
  experimentName: string;
  logger?: ExporterLogger;
  /** HTTP client for the network sinks. Defaults to `globalThis.fetch`; tests inject a fake. */
  fetch?: FetchLike;
}

export type JsonlExportConfig = Extract<ExportConfig, { type: 'jsonl' }>;
export type ParquetExportConfig = Extract<ExportConfig, { type: 'parquet' }>;
export type PostHogExportConfig = Extract<ExportConfig, { type: 'posthog' }>;
export type AmplitudeExportConfig = Extract<ExportConfig, { type: 'amplitude' }>;

/** The subset of `fetch` the exporters rely on, so tests can inject a fake without a server. */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | Blob;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export function defaultFetch(): FetchLike {
  return (url, init) => globalThis.fetch(url, init);
}

/** One failed operation of one sink. Network sinks collect these instead of throwing mid-run. */
export interface ExportFailure {
  exporter: string;
  operation: string;
  message: string;
  error: unknown;
  at: string;
}

/** A single sink operation that failed, e.g. an HTTP error from an analytics backend. */
export class SinkError extends AgonError {
  constructor(message: string, details?: unknown, cause?: unknown) {
    super(ErrorCodes.INTERNAL, message, { status: 502, details, cause });
    this.name = 'SinkError';
  }
}

/** Thrown from `close()` when one or more export operations failed during the run. */
export class ExportError extends AgonError {
  readonly failures: readonly ExportFailure[];

  constructor(message: string, failures: readonly ExportFailure[]) {
    super(ErrorCodes.INTERNAL, message, {
      status: 502,
      details: {
        failures: failures.map(({ exporter, operation, message: failureMessage, at }) => ({
          exporter,
          operation,
          message: failureMessage,
          at,
        })),
      },
      cause: failures[0]?.error,
    });
    this.name = 'ExportError';
    this.failures = failures;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collects failures during a run and turns them into one `ExportError` at close. */
export class FailureCollector {
  private readonly failures: ExportFailure[] = [];
  private readonly seen = new WeakSet<object>();

  constructor(
    private readonly exporter: string,
    private readonly logger?: ExporterLogger,
  ) {}

  /** Records a failure once; the same error object reported through two paths counts once. */
  record(operation: string, error: unknown, exporter = this.exporter): void {
    if (typeof error === 'object' && error !== null) {
      if (this.seen.has(error)) return;
      this.seen.add(error);
    }
    this.adopt({ exporter, operation, message: errorMessage(error), error, at: nowIso() });
  }

  adopt(failure: ExportFailure): void {
    this.failures.push(failure);
    this.logger?.warn(
      { exporter: failure.exporter, operation: failure.operation, err: failure.error },
      `export ${failure.operation} failed: ${failure.message}`,
    );
  }

  get size(): number {
    return this.failures.length;
  }

  list(): readonly ExportFailure[] {
    return [...this.failures];
  }

  throwIfAny(): void {
    const first = this.failures[0];
    if (!first) return;
    throw new ExportError(
      `${this.exporter}: ${this.failures.length} export operation(s) failed; first: ${first.exporter}.${first.operation}: ${first.message}`,
      this.failures,
    );
  }
}

/** Rejects the whole batch before any of it is written or sent. */
export function assertAllSimulated(events: readonly AgonEvent[]): void {
  for (const event of events) assertSimulated(event);
}

/** Validates the markers (throws `ValidationError`) and returns them typed. */
export function readMarkers(event: AgonEvent): SimProperties {
  assertSimulated(event);
  return SimPropertiesSchema.parse(event.properties);
}
