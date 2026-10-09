import { setTimeout as delay } from 'node:timers/promises';
import type { AgonEvent, Result, Run, Session, Step } from '@agon/spec';
import { analyticsStamp, simProperties } from '@agon/spec';
import type {
  AmplitudeExportConfig,
  ExportFailure,
  Exporter,
  ExporterContext,
  FetchLike,
} from './exporter.js';
import {
  FailureCollector,
  SinkError,
  assertAllSimulated,
  defaultFetch,
  readMarkers,
} from './exporter.js';

export interface AmplitudeExporterOptions {
  /** Overrides `ctx.fetch`; tests inject a fake. */
  fetch?: FetchLike;
  /** Events per upload request (default 500; Amplitude accepts up to 2000). */
  batchSize?: number;
  /** Retries after the first attempt on 408/429/5xx/network errors (default 3). */
  maxRetries?: number;
  /** Base backoff in ms, doubled per retry (default 500). */
  backoffMs?: number;
  requestTimeoutMs?: number;
  /** Injected for tests so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export const AMPLITUDE_DEFAULTS = {
  batchSize: 500,
  maxRetries: 3,
  backoffMs: 500,
  requestTimeoutMs: 10_000,
} as const;

/** One event in the HTTP API v2 `events` array. */
export interface AmplitudeEvent {
  user_id: string;
  event_type: string;
  /** Epoch milliseconds. */
  time: number;
  event_properties: Record<string, unknown>;
  user_properties: Record<string, unknown>;
  /** Deduplication key; Agon event ids are stable per run. */
  insert_id?: string;
}

export interface AmplitudeUploadBody {
  api_key: string;
  events: AmplitudeEvent[];
}

/**
 * Uploads to the Amplitude HTTP API v2 in batches of up to `batchSize` events: one
 * `$identify` per finished session (persona traits and variant as user properties) and one
 * event per Agon event, with `agon_variant`, `agon_persona` and `agon_model` as user properties.
 * Every event's properties carry the results contract stamp (`agon_schema_version`,
 * `agon_required_set`), see docs/results-contract.md.
 * 408/429/5xx responses and network errors are retried with exponential backoff; a batch that
 * still fails is recorded and surfaced as one `ExportError` from `close()`.
 */
export class AmplitudeExporter implements Exporter {
  readonly name = 'amplitude';
  private readonly apiKey: string;
  private readonly serverUrl: string;
  private readonly fetch: FetchLike;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly failures: FailureCollector;
  private readonly buffer: AmplitudeEvent[] = [];
  private sending: Promise<void> = Promise.resolve();
  private sent = 0;
  private closed = false;

  constructor(
    config: AmplitudeExportConfig,
    private readonly ctx: ExporterContext,
    options: AmplitudeExporterOptions = {},
  ) {
    this.apiKey = config.apiKey;
    this.serverUrl = config.serverUrl;
    this.fetch = options.fetch ?? ctx.fetch ?? defaultFetch();
    this.batchSize = Math.max(1, options.batchSize ?? AMPLITUDE_DEFAULTS.batchSize);
    this.maxRetries = options.maxRetries ?? AMPLITUDE_DEFAULTS.maxRetries;
    this.backoffMs = options.backoffMs ?? AMPLITUDE_DEFAULTS.backoffMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? AMPLITUDE_DEFAULTS.requestTimeoutMs;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.failures = new FailureCollector(this.name, ctx.logger);
  }

  async runStarted(run: Run): Promise<void> {
    this.ctx.logger?.info(
      { exporter: this.name, runId: run.id, serverUrl: this.serverUrl },
      'amplitude export started',
    );
  }

  async sessionFinished(session: Session): Promise<void> {
    this.buffer.push(identifyEvent(session));
    await this.drain(false);
  }

  async steps(_steps: Step[]): Promise<void> {
    // Steps are traces, not analytics events.
  }

  async events(events: AgonEvent[]): Promise<void> {
    assertAllSimulated(events);
    for (const event of events) this.buffer.push(toAmplitudeEvent(event));
    await this.drain(false);
  }

  async runFinished(_run: Run, _result?: Result): Promise<void> {
    await this.drain(true);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.drain(true);
      this.ctx.logger?.info(
        { exporter: this.name, sent: this.sent, failures: this.failures.size },
        'amplitude export closed',
      );
    }
    this.failures.throwIfAny();
  }

  errors(): readonly ExportFailure[] {
    return this.failures.list();
  }

  /** Events acknowledged by Amplitude so far. */
  get sentCount(): number {
    return this.sent;
  }

  /** Uploads full batches (all remaining events when `all`); uploads are serialized in order. */
  private async drain(all: boolean): Promise<void> {
    while (this.buffer.length >= this.batchSize || (all && this.buffer.length > 0)) {
      const batch = this.buffer.splice(0, this.batchSize);
      this.sending = this.sending.then(() => this.send(batch));
    }
    await this.sending;
  }

  private async send(batch: AmplitudeEvent[]): Promise<void> {
    const body: AmplitudeUploadBody = { api_key: this.apiKey, events: batch };
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.post(payload, batch.length);
      if (outcome.ok) {
        this.sent += batch.length;
        return;
      }
      if (!outcome.retryable || attempt >= this.maxRetries) {
        this.failures.record('upload', outcome.error);
        return;
      }
      const wait = this.backoffMs * 2 ** attempt;
      this.ctx.logger?.debug(
        { exporter: this.name, attempt: attempt + 1, waitMs: wait, err: outcome.error },
        'retrying amplitude upload',
      );
      await this.sleep(wait);
    }
  }

  private async post(
    payload: string,
    count: number,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; error: unknown }> {
    try {
      const response = await this.fetch(this.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: '*/*' },
        body: payload,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.status >= 200 && response.status < 300) return { ok: true };
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        error: new SinkError(
          `amplitude responded ${response.status} for a batch of ${count} events`,
          {
            status: response.status,
            body: text.slice(0, 1_000),
            events: count,
          },
        ),
      };
    } catch (error) {
      return { ok: false, retryable: true, error };
    }
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Throws `ValidationError` for an event without simulation markers. */
export function toAmplitudeEvent(event: AgonEvent): AmplitudeEvent {
  const markers = readMarkers(event);
  return {
    user_id: event.distinctId,
    event_type: event.event,
    time: Date.parse(event.timestamp),
    event_properties: { ...event.properties, ...analyticsStamp(markers) },
    user_properties: {
      agon_variant: markers.agon_variant,
      agon_persona: markers.agon_persona,
      agon_model: markers.agon_model,
    },
    insert_id: event.id,
  };
}

/** `$identify` carrying the persona traits and the variant as user properties. */
export function identifyEvent(session: Session): AmplitudeEvent {
  const persona = session.persona;
  const markers = simProperties({
    runId: session.runId,
    sessionId: session.id,
    variant: session.variant,
    personaId: persona.personaId,
    model: persona.model,
    scenarioId: session.scenarioId,
  });
  const at = session.finishedAt ?? session.startedAt;
  return {
    user_id: persona.distinctId,
    event_type: '$identify',
    time: at === undefined ? Date.now() : Date.parse(at),
    event_properties: { ...markers, ...analyticsStamp(markers) },
    user_properties: {
      agon_simulated: true,
      agon_variant: session.variant,
      agon_persona: persona.personaId,
      agon_persona_name: persona.name,
      agon_model: persona.model,
      agon_device: persona.device,
      agon_locale: persona.locale,
      agon_role: persona.traits.role,
      agon_tech_proficiency: persona.traits.techProficiency,
      agon_patience: persona.traits.patience,
      agon_attention: persona.traits.attention,
      agon_domain_familiarity: persona.traits.domainFamiliarity,
      agon_risk_tolerance: persona.traits.riskTolerance,
      agon_price_sensitivity: persona.traits.priceSensitivity,
    },
    insert_id: `${session.id}:identify`,
  };
}
