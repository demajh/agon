import { CONTRACT_SCHEMA_VERSION, ValidationError } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  EXPERIMENT_KEY,
  makeContext,
  makeRun,
  makeSession,
  makeUnmarkedEvent,
  runLifecycle,
} from './__fixtures__/fixtures.js';
import type { FetchLike } from './exporter.js';
import { ExportError } from './exporter.js';
import { PostHogExporter } from './posthog.js';

interface WireEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

interface Batch {
  api_key: string;
  batch: WireEvent[];
}

interface FakeFetch {
  fetch: FetchLike;
  calls: { url: string; body: Batch; headers: Record<string, string> }[];
  events: () => WireEvent[];
}

function fakeFetch(status: () => number = () => 200): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(String(init.body)) as Batch,
    });
    return { status: status(), text: async () => '', json: async () => ({}) };
  };
  return { fetch, calls, events: () => calls.flatMap((call) => call.body.batch) };
}

const config = {
  type: 'posthog' as const,
  projectApiKey: 'phc_simulation',
  host: 'https://sim.posthog.test',
  experimentKey: EXPERIMENT_KEY,
};

describe('PostHogExporter', () => {
  it('sends identify-style $set, exposures and events with the experiment and markers intact', async () => {
    const { fetch, calls, events } = fakeFetch();
    const exporter = new PostHogExporter(config, makeContext(), {
      fetch,
      flushAt: 5,
      fetchRetryCount: 0,
    });
    const data = await runLifecycle(exporter, { sessions: 3, eventsPerSession: 2 });
    await exporter.close();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe('https://sim.posthog.test/batch/');
      expect(call.body.api_key).toBe('phc_simulation');
      expect(call.headers['Content-Type']).toBe('application/json');
    }
    const wire = events();
    // 3 sessions x ($set + $feature_flag_called) + 6 events
    expect(wire).toHaveLength(12);
    expect(exporter.capturedCount).toBe(12);

    for (const session of data.sessions) {
      const set = wire.find(
        (e) => e.event === '$set' && e.distinct_id === session.persona.distinctId,
      );
      expect(set).toBeDefined();
      expect(set?.properties.$set).toMatchObject({
        agon_simulated: true,
        agon_persona: session.persona.personaId,
        agon_model: session.persona.model,
        agon_variant: session.variant,
        agon_device: session.persona.device,
        agon_patience: session.persona.traits.patience,
      });
      expect(set?.properties).toMatchObject({ agon_simulated: true, agon_run_id: session.runId });

      const exposure = wire.find(
        (e) => e.event === '$feature_flag_called' && e.distinct_id === session.persona.distinctId,
      );
      expect(exposure?.properties).toMatchObject({
        $feature_flag: EXPERIMENT_KEY,
        $feature_flag_response: session.variant,
        [`$feature/${EXPERIMENT_KEY}`]: session.variant,
        agon_simulated: true,
        agon_session_id: session.id,
      });
    }

    for (const event of data.events) {
      const sent = wire.find(
        (e) =>
          e.event === event.event &&
          e.distinct_id === event.distinctId &&
          e.properties.agon_session_id === event.sessionId &&
          Date.parse(e.timestamp) === Date.parse(event.timestamp),
      );
      expect(sent).toBeDefined();
      expect(sent?.properties).toMatchObject({
        ...event.properties,
        [`$feature/${EXPERIMENT_KEY}`]: event.properties.agon_variant,
      });
      expect(sent?.properties.agon_simulated).toBe(true);
    }
    // every capture carries the results contract stamp (docs/results-contract.md)
    for (const e of wire) {
      expect(e.properties).toMatchObject({
        agon_schema_version: CONTRACT_SCHEMA_VERSION,
        agon_required_set: 'agon.analytics_event.1',
      });
    }
    expect(exporter.errors()).toEqual([]);
  });

  it('batches according to flushAt and applies backpressure instead of dropping', async () => {
    const { fetch, calls, events } = fakeFetch();
    const exporter = new PostHogExporter(config, makeContext(), {
      fetch,
      flushAt: 4,
      fetchRetryCount: 0,
    });
    await runLifecycle(exporter, { sessions: 5, eventsPerSession: 3 });
    await exporter.close();
    expect(events()).toHaveLength(5 * 2 + 15);
    expect(calls.length).toBeGreaterThanOrEqual(Math.ceil(25 / 4));
    for (const call of calls) expect(call.body.batch.length).toBeLessThanOrEqual(4);
  });

  it('omits the experiment properties when no experimentKey is configured', async () => {
    const { fetch, events } = fakeFetch();
    const exporter = new PostHogExporter({ ...config, experimentKey: undefined }, makeContext(), {
      fetch,
      fetchRetryCount: 0,
    });
    await runLifecycle(exporter, { sessions: 1, eventsPerSession: 1 });
    await exporter.close();
    const wire = events();
    expect(wire.map((e) => e.event).sort()).toEqual(['$agon_session_start', '$set']);
    expect(wire.some((e) => Object.keys(e.properties).some((k) => k.startsWith('$feature')))).toBe(
      false,
    );
  });

  it('rejects an event without markers with ValidationError before any request', async () => {
    const { fetch, calls } = fakeFetch();
    const exporter = new PostHogExporter(config, makeContext(), { fetch, fetchRetryCount: 0 });
    await exporter.runStarted(makeRun());
    await expect(exporter.events([makeUnmarkedEvent(makeSession(0))])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await exporter.close();
    expect(calls).toHaveLength(0);
    expect(exporter.capturedCount).toBe(0);
  });

  it('never throws on network errors mid-run and surfaces them at close', async () => {
    const { fetch, calls } = fakeFetch(() => 500);
    const exporter = new PostHogExporter(config, makeContext(), {
      fetch,
      flushAt: 2,
      fetchRetryCount: 0,
    });
    await expect(
      runLifecycle(exporter, { sessions: 2, eventsPerSession: 2 }),
    ).resolves.toBeDefined();
    expect(calls.length).toBeGreaterThan(0);
    expect(exporter.errors().length).toBeGreaterThan(0);
    await expect(exporter.close()).rejects.toBeInstanceOf(ExportError);
    try {
      await exporter.close();
    } catch (error) {
      const exportError = error as ExportError;
      expect(exportError.failures[0]?.exporter).toBe('posthog');
      expect(exportError.failures[0]?.operation).toBe('flush');
      expect(exportError.toJSON().error.code).toBe('export_error');
    }
  });
});
