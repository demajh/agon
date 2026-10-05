export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
export const DEFAULT_POSTHOG_KEY = 'phc_ledgerly_demo';

/** Product events the app emits, both from the browser shim and into the server-side log. */
export const EVENTS = {
  pricingViewed: 'pricing_viewed',
  signupStarted: 'signup_started',
  signupCompleted: 'signup_completed',
  onboardingStepCompleted: 'onboarding_step_completed',
  onboardingSkipped: 'onboarding_skipped',
  projectCreated: 'project_created',
  dashboardViewed: 'dashboard_viewed',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface AnalyticsConfig {
  posthogHost: string;
  posthogKey: string;
}

/**
 * Browser shim that speaks the posthog-js wire format, so Agon's web adapter can intercept the
 * app's own analytics. Batches alternate between the two encodings posthog-js uses:
 *   POST {host}/e/?ip=1&_=<ts>   JSON array body, application/json
 *   POST {host}/capture/         data=<base64 JSON array>, application/x-www-form-urlencoded
 * Only `window`, `document`, `location`, `localStorage`, `navigator` and `fetch` are touched, so the
 * script also runs under a fake environment in tests.
 */
export function renderAnalyticsScript(config: AnalyticsConfig): string {
  return ANALYTICS_SHIM.replace('__POSTHOG_HOST__', JSON.stringify(config.posthogHost)).replace(
    '__POSTHOG_KEY__',
    JSON.stringify(config.posthogKey),
  );
}

const ANALYTICS_SHIM = `/* Ledgerly analytics shim: posthog-js wire format, no dependencies. */
(function () {
  'use strict';
  var HOST = __POSTHOG_HOST__;
  var TOKEN = __POSTHOG_KEY__;
  var LIB_VERSION = '1.0.0-ledgerly-shim';
  var FLUSH_DELAY_MS = 250;
  var STORAGE_KEY = 'ledgerly_distinct_id';
  var queue = [];
  var timer = null;
  var batches = 0;
  var superProperties = {};
  var distinctId = loadDistinctId();

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function loadDistinctId() {
    try {
      var id = localStorage.getItem(STORAGE_KEY);
      if (!id) { id = uuid(); localStorage.setItem(STORAGE_KEY, id); }
      return id;
    } catch (e) { return uuid(); }
  }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (!source) continue;
      for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }
  function utf8ToBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function enqueue(event, properties) {
    queue.push({
      event: event,
      properties: assign({
        distinct_id: distinctId,
        $current_url: location.href,
        $pathname: location.pathname,
        $host: location.host,
        $lib: 'posthog-js',
        $lib_version: LIB_VERSION,
        $insert_id: uuid(),
        token: TOKEN
      }, superProperties, properties),
      timestamp: new Date().toISOString(),
      uuid: uuid()
    });
    if (!timer) timer = setTimeout(flush, FLUSH_DELAY_MS);
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    var json = JSON.stringify(batch);
    if (batches++ % 2 === 0) {
      send(HOST + '/e/?ip=1&_=' + Date.now() + '&ver=' + LIB_VERSION, json, 'application/json');
    } else {
      send(HOST + '/capture/', 'data=' + encodeURIComponent(utf8ToBase64(json)), 'application/x-www-form-urlencoded');
    }
  }
  function send(url, body, contentType) {
    try {
      if (typeof fetch === 'function') {
        fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: body, keepalive: true, credentials: 'omit' })
          .catch(function () {});
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: contentType }));
      }
    } catch (e) { /* analytics must never break the page */ }
  }

  window.posthog = {
    init: function (token, config) {
      if (token) TOKEN = token;
      if (config && config.api_host) HOST = config.api_host;
    },
    capture: function (event, properties) { enqueue(event, properties); },
    identify: function (id, properties) {
      var previous = distinctId;
      distinctId = String(id);
      try { localStorage.setItem(STORAGE_KEY, distinctId); } catch (e) { /* storage unavailable */ }
      if (previous !== distinctId) enqueue('$identify', { $anon_distinct_id: previous, $set: properties || {} });
    },
    register: function (properties) { assign(superProperties, properties); },
    get_distinct_id: function () { return distinctId; },
    flush: flush
  };

  window.posthog.capture('$pageview', { title: document.title });
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
})();
`;
