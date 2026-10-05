import { gunzipSync } from 'node:zlib';
import { EventDraftSchema } from '@agon/spec';
import type { AnalyticsProvider, EventDraft } from '@agon/spec';

/**
 * URL globs (Playwright `page.route` semantics) that identify each provider's ingestion
 * endpoints. They match path shapes rather than hosts so first-party proxies are caught too.
 */
export const ANALYTICS_ROUTE_PATTERNS: Readonly<Record<AnalyticsProvider, readonly string[]>> = {
  posthog: ['**/e/**', '**/e?**', '**/capture/**', '**/batch/**', '**/decide/**', '**/flags/**'],
  segment: ['**/v1/t', '**/v1/track', '**/v1/p', '**/v1/page', '**/v1/i', '**/v1/batch'],
  amplitude: ['**/2/httpapi', '**/batch'],
  ga: ['**/g/collect**', '**/collect**'],
};

/** RegExp sources for the enabled providers' URL patterns, for scripts injected into the page. */
export function analyticsPatternSources(providers: readonly AnalyticsProvider[]): string[] {
  return providers.flatMap((p) =>
    ANALYTICS_ROUTE_PATTERNS[p].map((glob) => urlGlobToRegExp(glob).source),
  );
}

/** Emitted when an intercepted body could not be decoded; carries the body length instead. */
export const RAW_ANALYTICS_EVENT = '$agon_analytics_raw';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const SEGMENT_TYPE_EVENTS: Readonly<Record<string, string>> = {
  page: '$pageview',
  screen: '$screen',
  identify: '$identify',
  group: '$groupidentify',
  alias: '$create_alias',
};

const GLOB_ESCAPED = new Set([
  '$',
  '^',
  '+',
  '.',
  '*',
  '(',
  ')',
  '|',
  '\\',
  '?',
  '{',
  '}',
  '[',
  ']',
]);

/**
 * Converts a URL glob to a RegExp with the same rules Playwright applies in `page.route`:
 * `**` matches anything, `*` anything but `/`, `{a,b}` alternates, every other character
 * (including `?`) is literal.
 */
export function urlGlobToRegExp(glob: string): RegExp {
  const tokens: string[] = ['^'];
  let inGroup = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '\\' && i + 1 < glob.length) {
      i += 1;
      const next = glob[i] as string;
      tokens.push(GLOB_ESCAPED.has(next) ? `\\${next}` : next);
      continue;
    }
    if (c === '*') {
      const before = glob[i - 1];
      let stars = 1;
      while (glob[i + 1] === '*') {
        stars += 1;
        i += 1;
      }
      if (stars > 1) {
        const after = glob[i + 1];
        if (after === '/') {
          tokens.push(before === '/' ? '((.+/)|)' : '(.*/)');
          i += 1;
        } else {
          tokens.push('(.*)');
        }
      } else {
        tokens.push('([^/]*)');
      }
      continue;
    }
    switch (c) {
      case '{':
        if (inGroup) throw new Error(`invalid glob ${JSON.stringify(glob)}: nested '{'`);
        inGroup = true;
        tokens.push('(');
        break;
      case '}':
        if (!inGroup) throw new Error(`invalid glob ${JSON.stringify(glob)}: unmatched '}'`);
        inGroup = false;
        tokens.push(')');
        break;
      case ',':
        tokens.push(inGroup ? '|' : '\\,');
        break;
      default:
        tokens.push(GLOB_ESCAPED.has(c) ? `\\${c}` : c);
    }
  }
  if (inGroup) throw new Error(`invalid glob ${JSON.stringify(glob)}: unmatched '{'`);
  tokens.push('$');
  return new RegExp(tokens.join(''));
}

const compiledGlobs = new Map<string, RegExp>();

function globRegExp(glob: string): RegExp {
  let re = compiledGlobs.get(glob);
  if (!re) {
    re = urlGlobToRegExp(glob);
    compiledGlobs.set(glob, re);
  }
  return re;
}

/** The first enabled provider (in the order given) whose patterns match the full URL. */
export function matchAnalyticsProvider(
  url: string,
  providers: readonly AnalyticsProvider[],
): AnalyticsProvider | undefined {
  for (const provider of providers) {
    for (const pattern of ANALYTICS_ROUTE_PATTERNS[provider]) {
      if (globRegExp(pattern).test(url)) return provider;
    }
  }
  return undefined;
}

export interface AnalyticsRequest {
  provider: AnalyticsProvider;
  url: string;
  method: string;
  /** Request headers; keys are matched case-insensitively. */
  headers: Record<string, string>;
  body: Uint8Array | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function header(headers: Record<string, string>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? '' : (headers[key] ?? '');
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isGzip(body: Buffer): boolean {
  return body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
}

/** PostHog's `data=` parameter: JSON, or base64 of JSON. */
function decodeDataParam(data: string): unknown {
  const direct = tryJson(data);
  if (direct !== undefined) return direct;
  const decoded = Buffer.from(data.replace(/ /g, '+'), 'base64').toString('utf8');
  return decoded ? tryJson(decoded) : undefined;
}

function paramsToRecord(params: URLSearchParams): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

function eventItems(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload['batch'])) return payload['batch'].filter(isRecord);
  if (Array.isArray(payload['events'])) return payload['events'].filter(isRecord);
  return [payload];
}

function eventName(item: JsonRecord, provider: AnalyticsProvider): string | undefined {
  switch (provider) {
    case 'amplitude':
      return asString(item['event_type']) ?? asString(item['event']);
    case 'segment': {
      const type = asString(item['type']);
      if (type === undefined || type === 'track') return asString(item['event']);
      return SEGMENT_TYPE_EVENTS[type] ?? asString(item['event']);
    }
    case 'ga':
      return asString(item['en']) ?? asString(item['t']) ?? asString(item['event']);
    case 'posthog':
      return asString(item['event']);
  }
}

function eventProperties(item: JsonRecord, provider: AnalyticsProvider): JsonRecord {
  const properties: JsonRecord = {};
  let distinctId: string | undefined;
  switch (provider) {
    case 'amplitude': {
      if (isRecord(item['event_properties'])) Object.assign(properties, item['event_properties']);
      if (isRecord(item['user_properties'])) properties['$set'] = item['user_properties'];
      distinctId = asString(item['user_id']) ?? asString(item['device_id']);
      break;
    }
    case 'segment': {
      if (isRecord(item['properties'])) Object.assign(properties, item['properties']);
      if (isRecord(item['traits'])) properties['$set'] = item['traits'];
      const name = asString(item['name']);
      if (name !== undefined && properties['name'] === undefined) properties['name'] = name;
      distinctId = asString(item['userId']) ?? asString(item['anonymousId']);
      break;
    }
    case 'ga': {
      Object.assign(properties, item);
      distinctId = asString(item['cid']) ?? asString(item['uid']);
      break;
    }
    case 'posthog': {
      if (isRecord(item['properties'])) Object.assign(properties, item['properties']);
      distinctId =
        asString(item['distinct_id']) ??
        asString(properties['distinct_id']) ??
        asString(properties['$distinct_id']);
      break;
    }
  }
  if (distinctId !== undefined) properties['distinct_id'] = distinctId;
  return properties;
}

function toDrafts(payload: unknown, provider: AnalyticsProvider, timestamp: string): EventDraft[] {
  const drafts: EventDraft[] = [];
  for (const item of eventItems(payload)) {
    const event = eventName(item, provider);
    if (event === undefined) continue;
    drafts.push(
      EventDraftSchema.parse({
        timestamp,
        event,
        source: 'intercepted',
        provider,
        properties: eventProperties(item, provider),
      }),
    );
  }
  return drafts;
}

/** GA sends shared parameters in the query string and, when batching, one event per body line. */
function gaDrafts(search: URLSearchParams, bodyLines: string[], timestamp: string): EventDraft[] {
  const shared = paramsToRecord(search);
  const lines = bodyLines.map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return toDrafts(shared, 'ga', timestamp);
  return lines.flatMap((line) =>
    toDrafts({ ...shared, ...paramsToRecord(new URLSearchParams(line)) }, 'ga', timestamp),
  );
}

function rawDraft(
  request: AnalyticsRequest,
  timestamp: string,
  bodyLength: number,
  contentType: string,
  reason: string,
): EventDraft[] {
  return [
    EventDraftSchema.parse({
      timestamp,
      event: RAW_ANALYTICS_EVENT,
      source: 'intercepted',
      provider: request.provider,
      properties: {
        body_length: bodyLength,
        content_type: contentType,
        method: request.method,
        url: request.url.slice(0, 500),
        reason,
      },
    }),
  ];
}

/**
 * Turns one intercepted analytics request into event drafts. Understands JSON objects and arrays,
 * `{batch:[...]}` / `{events:[...]}` envelopes, PostHog's form-encoded `data=<base64 json>`,
 * gzip bodies (`compression=gzip-js` or a gzip magic number) and GA's query-string hits. Requests
 * that decode fine but carry no event (feature-flag or config calls) yield nothing; bodies that
 * cannot be decoded yield one `$agon_analytics_raw` draft. Never throws.
 */
export function parseAnalyticsRequest(request: AnalyticsRequest, timestamp: string): EventDraft[] {
  let search: URLSearchParams;
  try {
    search = new URL(request.url).searchParams;
  } catch {
    search = new URLSearchParams();
  }
  const contentType = header(request.headers, 'content-type').toLowerCase();
  let body: Buffer | null =
    request.body !== null && request.body.length > 0
      ? Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength)
      : null;
  const raw = (reason: string): EventDraft[] =>
    rawDraft(request, timestamp, request.body?.length ?? 0, contentType, reason);

  if (body !== null && body.length > MAX_BODY_BYTES) return raw('body too large');
  if (
    body !== null &&
    (search.get('compression') === 'gzip-js' ||
      header(request.headers, 'content-encoding').toLowerCase().includes('gzip') ||
      isGzip(body))
  ) {
    try {
      body = gunzipSync(body);
    } catch {
      return raw('gzip decode failed');
    }
  }

  const text = body === null ? '' : body.toString('utf8').trim();
  let payload: unknown;
  if (text.startsWith('{') || text.startsWith('[')) {
    payload = tryJson(text);
    if (payload === undefined) return raw('invalid json');
  } else if (
    text !== '' &&
    (contentType.includes('x-www-form-urlencoded') || /^[\w.%-]+=/.test(text))
  ) {
    const params = new URLSearchParams(text);
    const data = params.get('data');
    if (data !== null) {
      payload = decodeDataParam(data);
      if (payload === undefined) return raw('undecodable data parameter');
    } else if (request.provider === 'ga') {
      return gaDrafts(search, text.split(/\r?\n/), timestamp);
    } else {
      return raw('unrecognised form body');
    }
  } else if (text !== '') {
    return raw('unrecognised body');
  } else {
    const data = search.get('data');
    if (data !== null) {
      payload = decodeDataParam(data);
      if (payload === undefined) return raw('undecodable data parameter');
    } else if (request.provider === 'ga') {
      return gaDrafts(search, [], timestamp);
    } else {
      return [];
    }
  }
  return toDrafts(payload, request.provider, timestamp);
}
