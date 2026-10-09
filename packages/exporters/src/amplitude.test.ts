import { CONTRACT_SCHEMA_VERSION, ValidationError } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  makeContext,
  makeRun,
  makeSession,
  makeUnmarkedEvent,
  runLifecycle,
} from './__fixtures__/fixtures.js';
import type { AmplitudeUploadBody } from './amplitude.js';
import { AmplitudeExporter } from './amplitude.js';
import type { FetchLike } from './exporter.js';
import { ExportError } from './exporter.js';

interface FakeFetch {
  fetch: FetchLike;
  calls: { url: string; body: AmplitudeUploadBody; headers: Record<string, string> }[];
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

/** Each call answers with the next scripted status; the last status repeats. */
function fakeFetch(statuses: number[] = [200]): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)] ?? 200;
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(String(init.body)) as AmplitudeUploadBody,
    });
    return { status, text: async () => `status ${status}`, json: async () => ({}) };
  };
  return {
    fetch,
    calls,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

const config = {
  type: 'amplitude' as const,
  apiKey: 'amp_simulation',
  serverUrl: 'https://api2.amplitude.test/2/httpapi',
};

describe('AmplitudeExporter', () => {
  it('uploads events in the HTTP v2 shape with the variant as a user property', async () => {
    const { fetch, calls, sleep } = fakeFetch();
    const exporter = new AmplitudeExporter(config, makeContext(), { fetch, sleep });
    const data = await runLifecycle(exporter, { sessions: 2, eventsPerSession: 2 });
    await exporter.close();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(config.serverUrl);
    expect(call?.headers['Content-Type']).toBe('application/json');
    expect(call?.body.api_key).toBe('amp_simulation');
    const uploaded = call?.body.events ?? [];
    // 2 identify + 4 events
    expect(uploaded).toHaveLength(6);
    expect(exporter.sentCount).toBe(6);

    for (const event of data.events) {
      const sent = uploaded.find((e) => e.insert_id === event.id);
      expect(sent).toEqual({
        user_id: event.distinctId,
        event_type: event.event,
        time: Date.parse(event.timestamp),
        event_properties: {
          ...event.properties,
          agon_schema_version: CONTRACT_SCHEMA_VERSION,
          agon_required_set: 'agon.analytics_event.1',
        },
        user_properties: {
          agon_variant: event.properties.agon_variant,
          agon_persona: event.properties.agon_persona,
          agon_model: event.properties.agon_model,
        },
        insert_id: event.id,
      });
    }
    for (const session of data.sessions) {
      const identify = uploaded.find((e) => e.insert_id === `${session.id}:identify`);
      expect(identify?.event_type).toBe('$identify');
      expect(identify?.user_id).toBe(session.persona.distinctId);
      expect(identify?.user_properties).toMatchObject({
        agon_simulated: true,
        agon_variant: session.variant,
        agon_persona: session.persona.personaId,
        agon_model: session.persona.model,
      });
      expect(identify?.event_properties).toMatchObject({
        agon_simulated: true,
        agon_session_id: session.id,
      });
    }
    expect(exporter.errors()).toEqual([]);
  });

  it('splits uploads into batches of batchSize', async () => {
    const { fetch, calls, sleep } = fakeFetch();
    const exporter = new AmplitudeExporter(config, makeContext(), { fetch, sleep, batchSize: 4 });
    await runLifecycle(exporter, { sessions: 3, eventsPerSession: 2 });
    await exporter.close();
    // 3 identify + 6 events = 9 -> 4 + 4 + 1
    expect(calls.map((c) => c.body.events.length)).toEqual([4, 4, 1]);
    expect(exporter.sentCount).toBe(9);
  });

  it('retries with backoff on 500 then succeeds', async () => {
    const { fetch, calls, sleeps, sleep } = fakeFetch([500, 429, 200]);
    const exporter = new AmplitudeExporter(config, makeContext(), {
      fetch,
      sleep,
      maxRetries: 3,
      backoffMs: 100,
    });
    await runLifecycle(exporter, { sessions: 1, eventsPerSession: 1 });
    await exporter.close();
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect(exporter.errors()).toEqual([]);
    expect(exporter.sentCount).toBe(2);
  });

  it('gives up after maxRetries and surfaces the failure at close', async () => {
    const { fetch, calls, sleep } = fakeFetch([503]);
    const exporter = new AmplitudeExporter(config, makeContext(), { fetch, sleep, maxRetries: 2 });
    await runLifecycle(exporter, { sessions: 1, eventsPerSession: 1 });
    expect(calls).toHaveLength(3);
    expect(exporter.errors()).toHaveLength(1);
    expect(exporter.errors()[0]?.operation).toBe('upload');
    await expect(exporter.close()).rejects.toBeInstanceOf(ExportError);
  });

  it('does not retry client errors', async () => {
    const { fetch, calls, sleeps, sleep } = fakeFetch([400]);
    const exporter = new AmplitudeExporter(config, makeContext(), { fetch, sleep });
    await runLifecycle(exporter, { sessions: 1, eventsPerSession: 1 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    await expect(exporter.close()).rejects.toBeInstanceOf(ExportError);
  });

  it('retries when fetch itself fails', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNRESET');
      return { status: 200, text: async () => '', json: async () => ({}) };
    };
    const exporter = new AmplitudeExporter(config, makeContext(), {
      fetch,
      sleep: async () => undefined,
    });
    await runLifecycle(exporter, { sessions: 1, eventsPerSession: 1 });
    await exporter.close();
    expect(attempts).toBe(2);
    expect(exporter.errors()).toEqual([]);
  });

  it('rejects an event without markers with ValidationError before any request', async () => {
    const { fetch, calls, sleep } = fakeFetch();
    const exporter = new AmplitudeExporter(config, makeContext(), { fetch, sleep });
    await exporter.runStarted(makeRun());
    await expect(exporter.events([makeUnmarkedEvent(makeSession(0))])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await exporter.close();
    expect(calls).toHaveLength(0);
  });
});
