import { gzipSync } from 'node:zlib';
import { EventDraftSchema } from '@agon/spec';
import type { AnalyticsProvider } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_ROUTE_PATTERNS,
  RAW_ANALYTICS_EVENT,
  matchAnalyticsProvider,
  parseAnalyticsRequest,
  urlGlobToRegExp,
} from './analytics.js';

const NOW = '2026-10-04T17:00:00.000Z';
const ALL: AnalyticsProvider[] = ['posthog', 'segment', 'amplitude', 'ga'];

function request(
  provider: AnalyticsProvider,
  url: string,
  body: string | Buffer | null,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return {
    provider,
    url,
    method,
    headers,
    body: body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
  };
}

describe('urlGlobToRegExp', () => {
  it('follows Playwright glob rules: ** crosses slashes, * does not, ? is literal', () => {
    expect(urlGlobToRegExp('**/e/**').test('https://us.i.posthog.com/e/?ip=1&_=1')).toBe(true);
    expect(urlGlobToRegExp('**/e?**').test('https://app.posthog.com/e?ip=1')).toBe(true);
    expect(urlGlobToRegExp('**/e?**').test('https://app.posthog.com/ex')).toBe(false);
    expect(urlGlobToRegExp('**/v1/t').test('https://api.segment.io/v1/t')).toBe(true);
    expect(urlGlobToRegExp('**/v1/t').test('https://api.segment.io/v1/t/extra')).toBe(false);
    expect(urlGlobToRegExp('https://*.example.com/x').test('https://a.example.com/x')).toBe(true);
    expect(urlGlobToRegExp('https://*.example.com/x').test('https://a/b.example.com/x')).toBe(
      false,
    );
    expect(urlGlobToRegExp('**/{alpha,beta}').test('https://h/beta')).toBe(true);
    expect(urlGlobToRegExp('**/{alpha,beta}').test('https://h/gamma')).toBe(false);
  });

  it('rejects malformed groups', () => {
    expect(() => urlGlobToRegExp('**/{a')).toThrow(/unmatched/);
    expect(() => urlGlobToRegExp('**/a}')).toThrow(/unmatched/);
  });
});

describe('matchAnalyticsProvider', () => {
  it('matches every documented endpoint shape', () => {
    const cases: [string, AnalyticsProvider][] = [
      ['https://us.i.posthog.com/e/?ip=1&_=1', 'posthog'],
      ['https://app.posthog.com/e?ip=1', 'posthog'],
      ['https://proxy.example.com/ingest/capture/', 'posthog'],
      ['https://us.i.posthog.com/batch/', 'posthog'],
      ['https://us.i.posthog.com/decide/?v=3', 'posthog'],
      ['https://us.i.posthog.com/flags/?v=2', 'posthog'],
      ['https://api.segment.io/v1/t', 'segment'],
      ['https://api.segment.io/v1/track', 'segment'],
      ['https://api.segment.io/v1/p', 'segment'],
      ['https://api.segment.io/v1/page', 'segment'],
      ['https://api.segment.io/v1/i', 'segment'],
      ['https://api.segment.io/v1/batch', 'segment'],
      ['https://api2.amplitude.com/2/httpapi', 'amplitude'],
      ['https://api2.amplitude.com/batch', 'amplitude'],
      ['https://www.google-analytics.com/g/collect?v=2&tid=G-1', 'ga'],
      ['https://www.google-analytics.com/collect?v=1&t=pageview', 'ga'],
    ];
    for (const [url, provider] of cases) {
      expect(matchAnalyticsProvider(url, ALL), url).toBe(provider);
    }
  });

  it('only considers enabled providers, in the order given', () => {
    expect(matchAnalyticsProvider('https://us.i.posthog.com/e/', ['segment'])).toBeUndefined();
    expect(matchAnalyticsProvider('https://app.example.com/api/users', ALL)).toBeUndefined();
    expect(matchAnalyticsProvider('https://h/batch', ['posthog', 'amplitude'])).toBe('amplitude');
    expect(matchAnalyticsProvider('https://h/batch/', ['amplitude', 'posthog'])).toBe('posthog');
  });

  it('exposes the pattern table', () => {
    expect(ANALYTICS_ROUTE_PATTERNS.posthog).toContain('**/capture/**');
    expect(Object.keys(ANALYTICS_ROUTE_PATTERNS).sort()).toEqual(ALL.slice().sort());
  });
});

describe('parseAnalyticsRequest', () => {
  it('parses a PostHog JSON event and lifts $distinct_id into distinct_id', () => {
    const drafts = parseAnalyticsRequest(
      request(
        'posthog',
        'https://us.i.posthog.com/e/?ip=1',
        JSON.stringify({
          event: 'signup_viewed',
          properties: { $distinct_id: 'user-1', plan: 'pro' },
        }),
        { 'content-type': 'text/plain' },
      ),
      NOW,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      timestamp: NOW,
      event: 'signup_viewed',
      source: 'intercepted',
      provider: 'posthog',
      properties: { $distinct_id: 'user-1', plan: 'pro', distinct_id: 'user-1' },
    });
    expect(EventDraftSchema.safeParse(drafts[0]).success).toBe(true);
  });

  it('prefers a top-level distinct_id and unwraps arrays and batch envelopes', () => {
    const array = parseAnalyticsRequest(
      request(
        'posthog',
        'https://h/e/',
        JSON.stringify([
          { event: 'a', distinct_id: 'top', properties: { distinct_id: 'inner' } },
          { event: 'b', properties: {} },
          { not_an_event: true },
        ]),
      ),
      NOW,
    );
    expect(array.map((d) => d.event)).toEqual(['a', 'b']);
    expect(array[0]?.properties['distinct_id']).toBe('top');

    const batch = parseAnalyticsRequest(
      request(
        'posthog',
        'https://h/batch/',
        JSON.stringify({ api_key: 'phc_x', batch: [{ event: 'c', properties: { n: 1 } }] }),
      ),
      NOW,
    );
    expect(batch.map((d) => d.event)).toEqual(['c']);
    expect(batch[0]?.properties).toEqual({ n: 1 });
  });

  it('decodes PostHog form bodies with data=<base64 json>', () => {
    const payload = Buffer.from(
      JSON.stringify([{ event: 'cta_clicked', properties: { distinct_id: 'u1' } }]),
    ).toString('base64');
    const drafts = parseAnalyticsRequest(
      request(
        'posthog',
        'https://h/capture/',
        `data=${encodeURIComponent(payload)}&compression=base64`,
        { 'content-type': 'application/x-www-form-urlencoded' },
      ),
      NOW,
    );
    expect(drafts.map((d) => d.event)).toEqual(['cta_clicked']);
    expect(drafts[0]?.properties['distinct_id']).toBe('u1');
  });

  it('reads data= from the query string of a GET', () => {
    const data = encodeURIComponent(
      Buffer.from(JSON.stringify({ event: 'legacy_get', properties: {} })).toString('base64'),
    );
    const drafts = parseAnalyticsRequest(
      request('posthog', `https://h/e/?data=${data}&ip=1`, null, {}, 'GET'),
      NOW,
    );
    expect(drafts.map((d) => d.event)).toEqual(['legacy_get']);
  });

  it('gunzips compression=gzip-js bodies and bodies with a gzip magic number', () => {
    const body = gzipSync(
      Buffer.from(JSON.stringify([{ event: 'zipped', properties: { k: 'v' } }])),
    );
    const flagged = parseAnalyticsRequest(
      request('posthog', 'https://h/e/?compression=gzip-js', body, {
        'content-type': 'text/plain',
      }),
      NOW,
    );
    expect(flagged.map((d) => d.event)).toEqual(['zipped']);
    const unflagged = parseAnalyticsRequest(request('posthog', 'https://h/e/', body), NOW);
    expect(unflagged.map((d) => d.event)).toEqual(['zipped']);
  });

  it('yields nothing for decodable requests that carry no event (decide/flags)', () => {
    const drafts = parseAnalyticsRequest(
      request(
        'posthog',
        'https://h/decide/?v=3',
        JSON.stringify({ token: 'phc_x', distinct_id: 'u1', groups: {} }),
      ),
      NOW,
    );
    expect(drafts).toEqual([]);
    expect(
      parseAnalyticsRequest(request('posthog', 'https://h/flags/', null, {}, 'GET'), NOW),
    ).toEqual([]);
  });

  it('falls back to a raw event when the body cannot be decoded', () => {
    const garbage = parseAnalyticsRequest(
      request('posthog', 'https://h/e/', Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02])),
      NOW,
    );
    expect(garbage).toHaveLength(1);
    expect(garbage[0]?.event).toBe(RAW_ANALYTICS_EVENT);
    expect(garbage[0]?.properties).toMatchObject({ body_length: 5, reason: 'gzip decode failed' });

    const invalid = parseAnalyticsRequest(request('posthog', 'https://h/e/', '{not json'), NOW);
    expect(invalid[0]?.event).toBe(RAW_ANALYTICS_EVENT);
    expect(invalid[0]?.properties['reason']).toBe('invalid json');

    const binary = parseAnalyticsRequest(request('posthog', 'https://h/e/', 'plain words'), NOW);
    expect(binary[0]?.properties['reason']).toBe('unrecognised body');
  });

  it('parses Amplitude event envelopes', () => {
    const drafts = parseAnalyticsRequest(
      request(
        'amplitude',
        'https://api2.amplitude.com/2/httpapi',
        JSON.stringify({
          api_key: 'k',
          events: [
            {
              event_type: 'Checkout Started',
              user_id: 'amp-user',
              device_id: 'dev-1',
              event_properties: { total: 42 },
              user_properties: { plan: 'pro' },
            },
            { event_type: '[Amplitude] Page Viewed', device_id: 'dev-1' },
          ],
        }),
        { 'content-type': 'application/json' },
      ),
      NOW,
    );
    expect(drafts.map((d) => d.event)).toEqual(['Checkout Started', '[Amplitude] Page Viewed']);
    expect(drafts[0]?.properties).toEqual({
      total: 42,
      $set: { plan: 'pro' },
      distinct_id: 'amp-user',
    });
    expect(drafts[1]?.properties).toEqual({ distinct_id: 'dev-1' });
    expect(drafts.every((d) => d.provider === 'amplitude')).toBe(true);
  });

  it('parses Segment track, page and identify calls', () => {
    const track = parseAnalyticsRequest(
      request(
        'segment',
        'https://api.segment.io/v1/t',
        JSON.stringify({
          type: 'track',
          event: 'Order Completed',
          userId: 'seg-1',
          properties: { revenue: 9 },
        }),
      ),
      NOW,
    );
    expect(track[0]).toMatchObject({
      event: 'Order Completed',
      provider: 'segment',
      properties: { revenue: 9, distinct_id: 'seg-1' },
    });

    const batch = parseAnalyticsRequest(
      request(
        'segment',
        'https://api.segment.io/v1/batch',
        JSON.stringify({
          batch: [
            { type: 'page', name: 'Home', anonymousId: 'anon-1', properties: { path: '/' } },
            { type: 'identify', userId: 'seg-1', traits: { email: 'a@b.c' } },
          ],
        }),
      ),
      NOW,
    );
    expect(batch.map((d) => d.event)).toEqual(['$pageview', '$identify']);
    expect(batch[0]?.properties).toEqual({ path: '/', name: 'Home', distinct_id: 'anon-1' });
    expect(batch[1]?.properties).toEqual({ $set: { email: 'a@b.c' }, distinct_id: 'seg-1' });
  });

  it('parses GA hits from the query string and batched body lines', () => {
    const single = parseAnalyticsRequest(
      request(
        'ga',
        'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=555.666&en=page_view&dl=https%3A%2F%2Fx%2F',
        null,
        {},
        'POST',
      ),
      NOW,
    );
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({
      event: 'page_view',
      provider: 'ga',
      properties: { tid: 'G-1', distinct_id: '555.666', dl: 'https://x/' },
    });

    const batched = parseAnalyticsRequest(
      request(
        'ga',
        'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=555.666',
        'en=scroll&epn.percent_scrolled=90\nen=click&ep.link_text=Pricing',
        { 'content-type': 'text/plain' },
      ),
      NOW,
    );
    expect(batched.map((d) => d.event)).toEqual(['scroll', 'click']);
    expect(batched[1]?.properties).toMatchObject({
      'ep.link_text': 'Pricing',
      distinct_id: '555.666',
    });

    const universal = parseAnalyticsRequest(
      request(
        'ga',
        'https://www.google-analytics.com/collect?v=1&t=event&cid=1.2&ea=click',
        null,
        {},
        'GET',
      ),
      NOW,
    );
    expect(universal[0]?.event).toBe('event');
  });
});
