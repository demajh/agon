/**
 * Injected into every page before any script runs (Playwright `addInitScript`).
 *
 * Analytics SDKs send events with `fetch` and `navigator.sendBeacon`, and flush their last batch
 * during unload with `keepalive`. Chromium sends unload-time requests outside the page's network
 * stack, where `context.route` interception is best-effort at most. So for URLs matching the
 * configured providers this guard never touches the network: the request is handed to Node
 * through a Playwright binding (which parses it and decides whether to forward it) and the page
 * gets a synthetic 200. Route interception stays installed for XHR and image pixels.
 *
 * Must stay self-contained: it is serialized with `Function.prototype.toString`.
 */
export interface AnalyticsGuardArgs {
  /** RegExp sources matched against absolute URLs. */
  patterns: string[];
  /** Name of the binding exposed with `page.exposeBinding`. */
  binding: string;
}

/** Payload the guard hands to the binding; mirrored by `ScriptedAnalyticsSchema` in session.ts. */
export interface ScriptedAnalyticsPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  encoding: 'utf8' | 'base64';
}

export function analyticsGuard({ patterns, binding }: AnalyticsGuardArgs): void {
  const flagged = window as Window & { __agonAnalyticsGuard?: boolean };
  if (flagged.__agonAnalyticsGuard) return;
  flagged.__agonAnalyticsGuard = true;

  const matchers = patterns.map((p) => new RegExp(p));
  const absolute = (input: unknown): string | undefined => {
    try {
      return new URL(String(input), location.href).href;
    } catch {
      return undefined;
    }
  };
  const matches = (href: string | undefined): boolean =>
    href !== undefined && matchers.some((m) => m.test(href));

  const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 0x8000) {
      binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  type Encoded = { body: string | null; encoding: 'utf8' | 'base64' };
  const encodeBody = (body: unknown): Promise<Encoded> => {
    if (body === undefined || body === null)
      return Promise.resolve({ body: null, encoding: 'utf8' });
    if (typeof body === 'string') return Promise.resolve({ body, encoding: 'utf8' });
    if (body instanceof URLSearchParams)
      return Promise.resolve({ body: body.toString(), encoding: 'utf8' });
    if (body instanceof Blob)
      return body
        .arrayBuffer()
        .then((buf) => ({ body: toBase64(buf), encoding: 'base64' as const }));
    if (body instanceof ArrayBuffer)
      return Promise.resolve({ body: toBase64(body), encoding: 'base64' });
    if (ArrayBuffer.isView(body)) {
      const view = body as ArrayBufferView;
      return Promise.resolve({
        body: toBase64(
          view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
        ),
        encoding: 'base64',
      });
    }
    if (body instanceof FormData) {
      const params = new URLSearchParams();
      body.forEach((value, key) =>
        params.append(key, typeof value === 'string' ? value : value.name),
      );
      return Promise.resolve({ body: params.toString(), encoding: 'utf8' });
    }
    return Promise.resolve({ body: String(body), encoding: 'utf8' });
  };

  const headerRecord = (headers: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers as [string, string][])
        out[String(pair[0]).toLowerCase()] = String(pair[1]);
      return out;
    }
    for (const [key, value] of Object.entries(headers as Record<string, string>))
      out[key.toLowerCase()] = String(value);
    return out;
  };

  const deliver = (
    url: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
  ): void => {
    const send = (encoded: Encoded): void => {
      const fn = (window as unknown as Record<string, unknown>)[binding];
      if (typeof fn !== 'function') return;
      try {
        const result = (fn as (payload: unknown) => unknown)({ url, method, headers, ...encoded });
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        /* the page is going away; nothing to do */
      }
    };
    encodeBody(body).then(send, () => send({ body: null, encoding: 'utf8' }));
  };

  const fakeResponse = (): Response =>
    new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json' } });

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const href = absolute(request ? request.url : String(input));
    if (!matches(href)) return originalFetch(input, init);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = headerRecord(init?.headers ?? request?.headers);
    if (init?.body !== undefined || !request) {
      deliver(href as string, method, headers, init?.body);
    } else {
      request
        .clone()
        .arrayBuffer()
        .then(
          (buf) => deliver(href as string, method, headers, buf),
          () => deliver(href as string, method, headers, null),
        );
    }
    return Promise.resolve(fakeResponse());
  }) as typeof window.fetch;

  if (typeof navigator.sendBeacon === 'function') {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
      const href = absolute(url);
      if (!matches(href)) return originalBeacon(url, data);
      deliver(href as string, 'POST', {}, data);
      return true;
    };
  }
}
