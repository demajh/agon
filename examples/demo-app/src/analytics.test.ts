import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAnalyticsScript } from './analytics.js';

interface Sent {
  url: string;
  body: string;
  contentType: string;
}

interface WireEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  uuid: string;
}

interface Posthog {
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(id: string, properties?: Record<string, unknown>): void;
  register(properties: Record<string, unknown>): void;
  flush(): void;
  get_distinct_id(): string;
}

/** Runs the shim against a fake browser: the script only touches these globals. */
function boot(host = 'https://ph.example.test') {
  const sent: Sent[] = [];
  const storage = new Map<string, string>();
  const window: { posthog?: Posthog; addEventListener: () => void } = {
    addEventListener: () => {},
  };
  const document = {
    title: 'Pricing · Ledgerly',
    visibilityState: 'visible',
    addEventListener: () => {},
  };
  const location = {
    href: 'http://localhost:3001/pricing',
    pathname: '/pricing',
    host: 'localhost:3001',
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  const fetch = (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, body: init.body, contentType: init.headers['Content-Type'] ?? '' });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const run = new Function(
    'window',
    'document',
    'location',
    'localStorage',
    'navigator',
    'fetch',
    renderAnalyticsScript({ posthogHost: host, posthogKey: 'phc_test' }),
  ) as (...args: unknown[]) => void;
  run(window, document, location, localStorage, {}, fetch);
  if (!window.posthog) throw new Error('shim did not install window.posthog');
  return { posthog: window.posthog, sent, storage };
}

function decodeForm(body: string): WireEvent[] {
  expect(body.startsWith('data=')).toBe(true);
  const base64 = decodeURIComponent(body.slice('data='.length));
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as WireEvent[];
}

describe('analytics shim', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('captures $pageview on load and posts the first batch as a JSON array to /e/', () => {
    const { posthog, sent } = boot();
    posthog.capture('pricing_viewed', { plan: 'team' });
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(1);
    const first = sent[0];
    expect(first?.url).toMatch(/^https:\/\/ph\.example\.test\/e\/\?ip=1&_=\d+&ver=/);
    expect(first?.contentType).toBe('application/json');
    const batch = JSON.parse(first?.body ?? '') as WireEvent[];
    expect(batch.map((e) => e.event)).toEqual(['$pageview', 'pricing_viewed']);
    expect(batch[0]?.properties).toMatchObject({
      $current_url: 'http://localhost:3001/pricing',
      $pathname: '/pricing',
      $lib: 'posthog-js',
      token: 'phc_test',
      distinct_id: posthog.get_distinct_id(),
    });
    expect(batch[1]?.properties['plan']).toBe('team');
    expect(batch[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(batch[0]?.uuid).toBeTruthy();
  });

  it('posts every other batch form-encoded as base64 JSON to /capture/', () => {
    const { posthog, sent } = boot();
    vi.advanceTimersByTime(250); // batch 1: $pageview via /e/

    posthog.register({ variant: 'treatment' });
    posthog.capture('project_created', { variant: 'treatment' });
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(2);
    const second = sent[1];
    expect(second?.url).toBe('https://ph.example.test/capture/');
    expect(second?.contentType).toBe('application/x-www-form-urlencoded');
    const decoded = decodeForm(second?.body ?? '');
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.event).toBe('project_created');
    expect(decoded[0]?.properties['variant']).toBe('treatment');

    posthog.capture('dashboard_viewed');
    vi.advanceTimersByTime(250);
    expect(sent[2]?.url).toContain('/e/?ip=1');
    const third = JSON.parse(sent[2]?.body ?? '') as WireEvent[];
    // Registered super properties ride along on every later event.
    expect(third[0]?.properties['variant']).toBe('treatment');
  });

  it('identify switches the distinct id, persists it, and emits $identify once', () => {
    const { posthog, sent, storage } = boot();
    const anonymous = posthog.get_distinct_id();
    expect(storage.get('ledgerly_distinct_id')).toBe(anonymous);

    posthog.identify('usr_123', { email: 'ana@example.com' });
    posthog.identify('usr_123');
    expect(posthog.get_distinct_id()).toBe('usr_123');
    expect(storage.get('ledgerly_distinct_id')).toBe('usr_123');

    posthog.flush();
    const batch = JSON.parse(sent[0]?.body ?? '') as WireEvent[];
    const identifies = batch.filter((e) => e.event === '$identify');
    expect(identifies).toHaveLength(1);
    expect(identifies[0]?.properties).toMatchObject({
      distinct_id: 'usr_123',
      $anon_distinct_id: anonymous,
      $set: { email: 'ana@example.com' },
    });
  });

  it('reuses a stored distinct id across page loads', () => {
    const first = boot();
    const second = boot();
    expect(first.posthog.get_distinct_id()).not.toBe(second.posthog.get_distinct_id());
    expect(first.storage.get('ledgerly_distinct_id')).toBe(first.posthog.get_distinct_id());
  });
});
