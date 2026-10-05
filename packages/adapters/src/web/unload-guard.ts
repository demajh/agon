/**
 * Injected into every page before any script runs (Playwright `addInitScript`). Analytics SDKs
 * flush their last batch during unload with `navigator.sendBeacon` or `fetch(..., { keepalive })`,
 * and Chromium sends those outside the page's network stack, where `context.route` never sees
 * them. For URLs matching the configured providers this turns beacons into ordinary fetches and
 * strips `keepalive`, so the request is either intercepted like any other or cancelled with the
 * page, and simulated events never reach a real analytics project.
 *
 * Must stay self-contained: it is serialized with `Function.prototype.toString`.
 */
export interface UnloadGuardArgs {
  /** RegExp sources matched against absolute URLs. */
  patterns: string[];
}

export function unloadGuard({ patterns }: UnloadGuardArgs): void {
  const flagged = window as Window & { __agonUnloadGuard?: boolean };
  if (flagged.__agonUnloadGuard) return;
  flagged.__agonUnloadGuard = true;
  const matchers = patterns.map((p) => new RegExp(p));
  const matches = (input: unknown): boolean => {
    try {
      const href = new URL(String(input), location.href).href;
      return matchers.some((m) => m.test(href));
    } catch {
      return false;
    }
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (init?.keepalive && matches(url)) init = { ...init, keepalive: false };
    return originalFetch(input, init);
  }) as typeof window.fetch;
  if (typeof navigator.sendBeacon === 'function') {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
      if (!matches(url)) return originalBeacon(url, data);
      originalFetch(String(url), {
        method: 'POST',
        body: data ?? null,
        keepalive: false,
        credentials: 'include',
        mode: 'no-cors',
      }).catch(() => undefined);
      return true;
    };
  }
}
