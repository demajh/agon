import type { AgonEvent, Result, Run, Session, Step } from '@agon/spec';
import { simProperties } from '@agon/spec';
import { PostHog } from 'posthog-node';
import type {
  ExportFailure,
  Exporter,
  ExporterContext,
  FetchLike,
  PostHogExportConfig,
} from './exporter.js';
import { FailureCollector, SinkError, assertAllSimulated, readMarkers } from './exporter.js';

type PostHogClientOptions = NonNullable<ConstructorParameters<typeof PostHog>[1]>;
type PostHogFetch = NonNullable<PostHogClientOptions['fetch']>;
type PostHogCaptureMessage = Parameters<PostHog['capture']>[0];

export interface PostHogExporterOptions {
  /** Overrides `ctx.fetch`; tests inject a fake that records request bodies. */
  fetch?: FetchLike;
  /** Events per `/batch/` request and the backpressure threshold (default 100). */
  flushAt?: number;
  /** Periodic background flush in ms (default 2000). */
  flushInterval?: number;
  requestTimeoutMs?: number;
  /** Retries for 408/429/5xx/network errors inside posthog-node (default 3). */
  fetchRetryCount?: number;
  fetchRetryDelayMs?: number;
  shutdownTimeoutMs?: number;
}

export const POSTHOG_DEFAULTS = {
  flushAt: 100,
  flushInterval: 2_000,
  requestTimeoutMs: 10_000,
  fetchRetryCount: 3,
  fetchRetryDelayMs: 1_000,
  shutdownTimeoutMs: 30_000,
} as const;

/**
 * Sends sessions and events to a PostHog project (ideally a separate "simulation" project)
 * in the shape PostHog's own Experiments UI reads:
 * - per finished session a `$set` event with the persona traits on the persona's distinct id and,
 *   when `experimentKey` is configured, a `$feature_flag_called` exposure
 *   (`$feature_flag`, `$feature_flag_response` = variant);
 * - per event a capture carrying the original properties (markers included) plus
 *   `$feature/<experimentKey>` = variant.
 *
 * Network errors never throw mid-run: posthog-node retries, then the failure is recorded and
 * surfaced as one `ExportError` from `close()`. Captures apply backpressure: every `flushAt`
 * events the exporter awaits a flush so the client's queue cannot overflow and drop events.
 */
export class PostHogExporter implements Exporter {
  readonly name = 'posthog';
  readonly experimentKey: string | undefined;
  private readonly client: PostHog;
  private readonly failures: FailureCollector;
  private readonly flushAt: number;
  private readonly shutdownTimeoutMs: number;
  private pending = 0;
  private captured = 0;
  private flushing: Promise<void> | undefined;
  private shutDown = false;

  constructor(
    config: PostHogExportConfig,
    private readonly ctx: ExporterContext,
    options: PostHogExporterOptions = {},
  ) {
    this.experimentKey = config.experimentKey;
    this.failures = new FailureCollector(this.name, ctx.logger);
    this.flushAt = options.flushAt ?? POSTHOG_DEFAULTS.flushAt;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? POSTHOG_DEFAULTS.shutdownTimeoutMs;
    const clientOptions: PostHogClientOptions = {
      host: config.host,
      flushAt: this.flushAt,
      maxBatchSize: this.flushAt,
      flushInterval: options.flushInterval ?? POSTHOG_DEFAULTS.flushInterval,
      maxQueueSize: Math.max(this.flushAt * 100, 10_000),
      requestTimeout: options.requestTimeoutMs ?? POSTHOG_DEFAULTS.requestTimeoutMs,
      fetchRetryCount: options.fetchRetryCount ?? POSTHOG_DEFAULTS.fetchRetryCount,
      fetchRetryDelay: options.fetchRetryDelayMs ?? POSTHOG_DEFAULTS.fetchRetryDelayMs,
      disableGeoip: true,
      disableCompression: true,
      disableRemoteConfig: true,
      disableSurveys: true,
      preloadFeatureFlags: false,
      disableRemoteFeatureFlags: true,
      featureFlagsPollingInterval: null,
    };
    const fetchLike = options.fetch ?? ctx.fetch;
    if (fetchLike) clientOptions.fetch = adaptFetch(fetchLike);
    this.client = new PostHog(config.projectApiKey, clientOptions);
    this.client.on('error', (error: unknown) => this.failures.record('flush', error));
  }

  async runStarted(run: Run): Promise<void> {
    this.ctx.logger?.info(
      { exporter: this.name, runId: run.id, experimentKey: this.experimentKey },
      'posthog export started',
    );
  }

  async sessionFinished(session: Session): Promise<void> {
    const persona = session.persona;
    const markers = simProperties({
      runId: session.runId,
      sessionId: session.id,
      variant: session.variant,
      personaId: persona.personaId,
      model: persona.model,
      scenarioId: session.scenarioId,
    });
    const timestamp = optionalDate(session.startedAt ?? session.finishedAt);
    this.capture({
      distinctId: persona.distinctId,
      event: '$set',
      properties: { ...markers, $set: personaProperties(session) },
      timestamp,
    });
    if (this.experimentKey) {
      this.capture({
        distinctId: persona.distinctId,
        event: '$feature_flag_called',
        properties: {
          ...markers,
          $feature_flag: this.experimentKey,
          $feature_flag_response: session.variant,
          [`$feature/${this.experimentKey}`]: session.variant,
        },
        timestamp,
      });
    }
    await this.flushIfDue();
  }

  async steps(_steps: Step[]): Promise<void> {
    // Steps are traces, not analytics events; PostHog receives sessions and events only.
  }

  async events(events: AgonEvent[]): Promise<void> {
    assertAllSimulated(events);
    for (const event of events) {
      const markers = readMarkers(event);
      const properties: Record<string, unknown> = { ...event.properties };
      if (this.experimentKey) properties[`$feature/${this.experimentKey}`] = markers.agon_variant;
      this.capture({
        distinctId: event.distinctId,
        event: event.event,
        timestamp: new Date(event.timestamp),
        properties,
      });
    }
    await this.flushIfDue();
  }

  async runFinished(_run: Run, _result?: Result): Promise<void> {
    await this.flush();
    await this.shutdown();
  }

  async close(): Promise<void> {
    if (!this.shutDown) {
      await this.flush();
      await this.shutdown();
    }
    this.failures.throwIfAny();
  }

  /** Failures collected so far (network errors are never thrown mid-run). */
  errors(): readonly ExportFailure[] {
    return this.failures.list();
  }

  /** Number of messages handed to the client so far. */
  get capturedCount(): number {
    return this.captured;
  }

  private capture(message: PostHogCaptureMessage): void {
    if (this.shutDown) throw new SinkError('posthog exporter is already shut down');
    this.client.capture(message);
    this.pending += 1;
    this.captured += 1;
  }

  private flushIfDue(): Promise<void> {
    return this.pending >= this.flushAt ? this.flush() : Promise.resolve();
  }

  private flush(): Promise<void> {
    if (!this.flushing) {
      this.pending = 0;
      const current = this.client
        .flush()
        .catch((error: unknown) => this.failures.record('flush', error))
        .finally(() => {
          if (this.flushing === current) this.flushing = undefined;
        });
      this.flushing = current;
    }
    return this.flushing;
  }

  private async shutdown(): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;
    try {
      await this.client.shutdown(this.shutdownTimeoutMs);
    } catch (error) {
      this.failures.record('shutdown', error);
    }
    this.ctx.logger?.info(
      { exporter: this.name, captured: this.captured, failures: this.failures.size },
      'posthog export closed',
    );
  }
}

/** Persona traits as person properties; all keys are `agon_`-prefixed so they never clobber real ones. */
export function personaProperties(session: Session): Record<string, unknown> {
  const persona = session.persona;
  return {
    agon_simulated: true,
    agon_persona: persona.personaId,
    agon_persona_name: persona.name,
    agon_model: persona.model,
    agon_variant: session.variant,
    agon_device: persona.device,
    agon_locale: persona.locale,
    agon_role: persona.traits.role,
    agon_tech_proficiency: persona.traits.techProficiency,
    agon_patience: persona.traits.patience,
    agon_attention: persona.traits.attention,
    agon_domain_familiarity: persona.traits.domainFamiliarity,
    agon_risk_tolerance: persona.traits.riskTolerance,
    agon_price_sensitivity: persona.traits.priceSensitivity,
  };
}

function optionalDate(iso: string | undefined): Date | undefined {
  return iso === undefined ? undefined : new Date(iso);
}

function adaptFetch(fetchLike: FetchLike): PostHogFetch {
  return async (url, options) => {
    const response = await fetchLike(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
    return {
      status: response.status,
      text: () => response.text(),
      json: () => response.json(),
    };
  };
}
