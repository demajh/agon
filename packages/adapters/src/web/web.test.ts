import { AdapterError, INFERRED_EVENTS } from '@agon/spec';
import type { AdapterSession, Capture, Device, EventDraft, Observation } from '@agon/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebAdapter } from '../index.js';
import type { WebAdapter } from '../index.js';
import { startFixtureServer } from './__fixtures__/server.js';
import type { FixtureServer } from './__fixtures__/server.js';

let server: FixtureServer;
let adapter: WebAdapter;
const sessions: AdapterSession[] = [];

const baseCapture: Capture = {
  analytics: [],
  forwardAnalytics: false,
  networkErrors: true,
  consoleErrors: true,
  screenshots: 'every_step',
};

interface OpenOverrides {
  device?: Device;
  locale?: string;
  headers?: Record<string, string>;
  capture?: Partial<Capture>;
}

async function open(startPath: string, overrides: OpenOverrides = {}): Promise<AdapterSession> {
  const session = await adapter.open(
    { url: server.baseUrl, env: {}, headers: { 'x-variant-header': 'from-variant' } },
    {
      sessionId: 'ses_test_00001',
      variant: 'control',
      startPath,
      viewport: { width: 1280, height: 800 },
      device: overrides.device ?? 'desktop',
      locale: overrides.locale ?? 'en-US',
      capture: { ...baseCapture, ...overrides.capture },
      ...(overrides.headers ? { headers: overrides.headers } : {}),
    },
  );
  sessions.push(session);
  return session;
}

function byName(observation: Observation, name: string) {
  const element = observation.interactive.find((e) => e.name === name);
  if (!element)
    throw new Error(`no element named "${name}" in ${JSON.stringify(observation.interactive)}`);
  return element;
}

async function observeUntil(
  session: AdapterSession,
  predicate: (observation: Observation) => boolean,
  attempts = 30,
): Promise<Observation> {
  let observation = await session.observe();
  for (let i = 0; i < attempts && !predicate(observation); i += 1) {
    await session.act({ type: 'wait', ms: 100 });
    observation = await session.observe();
  }
  return observation;
}

beforeAll(async () => {
  server = await startFixtureServer();
  adapter = createWebAdapter({ actionTimeoutMs: 2_000, settleTimeoutMs: 1_000 });
});

afterAll(async () => {
  await Promise.all(sessions.map((s) => s.close()));
  await adapter.dispose();
  await server.close();
});

describe('observe', () => {
  it('returns refs, roles, names, hrefs and readable text in document order', async () => {
    const session = await open('/');
    expect(session.kind).toBe('web');
    const obs = await session.observe();

    expect(obs.url).toBe(`${server.baseUrl}/`);
    expect(obs.title).toBe('Agon Demo');
    expect(obs.text).toContain('Welcome to Agon Demo');
    expect(obs.text).toContain('The two-variant onboarding app used by the adapter tests.');
    expect(obs.text).toContain('\n');
    expect(obs.truncated).toBe(false);
    expect(obs.errors).toEqual([]);
    expect(obs.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(obs.screenshotRef).toBeUndefined();
    expect(Date.parse(obs.capturedAt)).not.toBeNaN();

    expect(obs.interactive.map((e) => e.name)).toEqual([
      'Sign up',
      'Pricing',
      'Errors',
      'Open step two',
    ]);
    expect(obs.interactive.map((e) => e.role)).toEqual(['link', 'link', 'link', 'button']);
    expect(byName(obs, 'Sign up').href).toBe(`${server.baseUrl}/signup`);
    const refs = obs.interactive.map((e) => e.ref);
    expect(refs.every((ref) => /^e\d+$/.test(ref))).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
    expect(obs.interactive.every((e) => e.disabled === false)).toBe(true);
  });

  it('reuses refs for the same elements across observes and hashes equal views equally', async () => {
    const session = await open('/');
    const first = await session.observe();
    const second = await session.observe();
    expect(second.interactive).toEqual(first.interactive);
    expect(second.hash).toBe(first.hash);
  });

  it('describes form controls with accessible names, values, checked and disabled state', async () => {
    const session = await open('/controls');
    const obs = await session.observe();
    const names = obs.interactive.map((e) => e.name);

    expect(byName(obs, 'Email address')).toMatchObject({ role: 'textbox', value: '' });
    expect(byName(obs, 'Search the docs')).toMatchObject({ role: 'textbox', value: 'playwright' });
    expect(byName(obs, 'Promo code').role).toBe('textbox');
    expect(byName(obs, 'Plan (options: Free, Pro, Team)')).toMatchObject({
      role: 'combobox',
      value: 'Free',
    });
    expect(byName(obs, 'I accept the terms')).toMatchObject({ role: 'checkbox', checked: false });
    expect(byName(obs, 'Small')).toMatchObject({ role: 'radio', checked: true });
    expect(byName(obs, 'Large')).toMatchObject({ role: 'radio', checked: false });
    expect(byName(obs, 'Notes')).toMatchObject({ role: 'textbox', value: 'hello' });
    expect(byName(obs, 'Editor')).toMatchObject({ role: 'textbox', value: 'Draft' });
    expect(byName(obs, 'Fancy button').role).toBe('button');
    expect(byName(obs, 'Focusable card').role).toBe('clickable');
    expect(byName(obs, 'Clickable span').role).toBe('clickable');
    expect(byName(obs, 'Disabled action')).toMatchObject({ role: 'button', disabled: true });
    expect(byName(obs, 'Company logo')).toMatchObject({
      role: 'link',
      href: `${server.baseUrl}/logo`,
    });
    expect(byName(obs, 'Settings').role).toBe('button');
    expect(byName(obs, 'Dark mode')).toMatchObject({ role: 'switch', checked: true });

    expect(names).not.toContain('Hidden link');
    expect(names).not.toContain('Invisible link');
    expect(names).not.toContain('Decorative');
    expect(names).not.toContain('csrf');
  });

  it('ignores controls parked off-canvas, such as unfocused skip links', async () => {
    const session = await open('/offscreen');
    const obs = await session.observe();
    expect(obs.interactive.map((e) => e.name)).toEqual(['Real button']);
    await session.close();
  });

  it('caps interactive elements and text, keeping document order', async () => {
    const session = await open('/many');
    const obs = await session.observe();
    expect(obs.interactive).toHaveLength(40);
    expect(obs.interactive[0]?.name).toBe('Button 1');
    expect(obs.interactive[39]?.name).toBe('Button 40');
    expect(obs.text.length).toBeLessThanOrEqual(4000);
    expect(obs.text.length).toBeGreaterThan(3000);
    expect(obs.truncated).toBe(true);

    const small = await session.observe({ maxInteractive: 10, maxTextChars: 500 });
    expect(small.interactive).toHaveLength(10);
    expect(small.interactive[9]?.name).toBe('Button 10');
    expect(small.text.length).toBeLessThanOrEqual(500);
    expect(small.truncated).toBe(true);
    expect(small.hash).not.toBe(obs.hash);
  });
});

describe('act', () => {
  it('fills and submits a form; client-side validation failures do not navigate', async () => {
    const session = await open('/signup');
    let obs = await session.observe();
    const email = byName(obs, 'Email address').ref;
    const password = byName(obs, 'Password').ref;
    const submit = byName(obs, 'Create account').ref;

    const rejected = await session.act({ type: 'click', ref: submit });
    expect(rejected).toEqual({ ok: true, navigated: false });
    obs = await session.observe();
    expect(obs.url).toBe(`${server.baseUrl}/signup`);
    expect(obs.text).toContain('Enter a valid email address');

    expect(await session.act({ type: 'fill', ref: email, text: 'ada@example.com' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(
      await session.act({ type: 'fill', ref: password, text: 'correct horse battery' }),
    ).toEqual({
      ok: true,
      navigated: false,
    });
    obs = await session.observe();
    expect(byName(obs, 'Email address').value).toBe('ada@example.com');
    expect(byName(obs, 'Password').value).toMatch(/^•+$/);

    const accepted = await session.act({ type: 'click', ref: submit });
    expect(accepted).toEqual({ ok: true, navigated: true });
    obs = await session.observe();
    expect(obs.url).toBe(`${server.baseUrl}/welcome`);
    expect(obs.text).toContain('Welcome aboard');
    expect(server.hitCount('/welcome')).toBeGreaterThanOrEqual(1);
  });

  it('selects options, toggles checkboxes and radios through fill and click', async () => {
    const session = await open('/controls');
    let obs = await session.observe();
    const plan = byName(obs, 'Plan (options: Free, Pro, Team)').ref;
    const terms = byName(obs, 'I accept the terms').ref;
    const large = byName(obs, 'Large').ref;

    expect(await session.act({ type: 'select', ref: plan, value: 'Pro' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'fill', ref: terms, text: 'true' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'click', ref: large })).toEqual({
      ok: true,
      navigated: false,
    });
    obs = await session.observe();
    expect(byName(obs, 'Plan (options: Free, Pro, Team)').value).toBe('Pro');
    expect(byName(obs, 'I accept the terms').checked).toBe(true);
    expect(byName(obs, 'Large').checked).toBe(true);
    expect(byName(obs, 'Small').checked).toBe(false);

    expect(await session.act({ type: 'select', ref: plan, value: 'team' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(byName(await session.observe(), 'Plan (options: Free, Pro, Team)').value).toBe('Team');
  });

  it('reports recoverable failures as ok:false instead of throwing', async () => {
    const session = await open('/controls');
    const obs = await session.observe();
    const disabled = byName(obs, 'Disabled action').ref;
    const plan = byName(obs, 'Plan (options: Free, Pro, Team)').ref;
    const fancy = byName(obs, 'Fancy button').ref;

    const missing = await session.act({ type: 'click', ref: 'e999' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/e999/);

    const malformed = await session.act({ type: 'click', ref: 'nope' });
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toMatch(/unknown element ref/);

    const notEnabled = await session.act({ type: 'click', ref: disabled });
    expect(notEnabled).toMatchObject({
      ok: false,
      error: `${disabled} is disabled`,
      navigated: false,
    });

    const badOption = await session.act({ type: 'select', ref: plan, value: 'Enterprise' });
    expect(badOption.ok).toBe(false);
    expect(badOption.error).toMatch(/options: Free, Pro, Team/);

    const notASelect = await session.act({ type: 'select', ref: fancy, value: 'x' });
    expect(notASelect.ok).toBe(false);
    expect(notASelect.error).toMatch(/not a <select>/);

    const notTypable = await session.act({ type: 'fill', ref: fancy, text: 'x' });
    expect(notTypable.ok).toBe(false);
    expect(notTypable.error).toMatch(/cannot be typed into/);

    const badKey = await session.act({ type: 'press', key: 'NotAKeyAtAll' });
    expect(badKey.ok).toBe(false);

    const badUrl = await session.act({ type: 'navigate', url: 'javascript:alert(1)' });
    expect(badUrl).toMatchObject({ ok: false, navigated: false });
    expect(badUrl.error).toMatch(/only http/);

    const unreachable = await session.act({
      type: 'navigate',
      url: 'http://127.0.0.1:9/nothing-listens-here',
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.error).toMatch(
      /navigation to http:\/\/127\.0\.0\.1:9\/nothing-listens-here failed/,
    );

    const invalid = await session.act({ type: 'wait', ms: -1 } as never);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/invalid action/);
  });

  it('navigates relative to the current origin, goes back, and infers $pageview events', async () => {
    const session = await open('/');
    session.drainEvents();

    const forward = await session.act({ type: 'navigate', url: '/pricing' });
    expect(forward).toEqual({ ok: true, navigated: true });
    expect((await session.observe()).url).toBe(`${server.baseUrl}/pricing`);

    const back = await session.act({ type: 'back' });
    expect(back).toEqual({ ok: true, navigated: true });
    let obs = await session.observe();
    expect(obs.url).toBe(`${server.baseUrl}/`);

    const spa = await session.act({ type: 'click', ref: byName(obs, 'Open step two').ref });
    expect(spa).toEqual({ ok: true, navigated: true });
    obs = await session.observe();
    expect(obs.url).toBe(`${server.baseUrl}/spa/step-two`);
    expect(obs.text).toContain('Step two');

    const pageviews = session.drainEvents().filter((e) => e.event === INFERRED_EVENTS.pageview);
    expect(pageviews.map((e) => e.properties['$current_url'])).toEqual([
      `${server.baseUrl}/pricing`,
      `${server.baseUrl}/`,
      `${server.baseUrl}/spa/step-two`,
    ]);
    expect(pageviews.every((e) => e.source === 'inferred' && e.provider === undefined)).toBe(true);
    expect(pageviews[0]?.properties).toMatchObject({
      $pathname: '/pricing',
      $referrer: `${server.baseUrl}/`,
    });
    expect(session.drainEvents()).toEqual([]);

    const nowhere = await session.act({ type: 'back' });
    expect(nowhere).toEqual({ ok: true, navigated: true });
    const tooFar = await session.act({ type: 'navigate', url: '/pricing' });
    expect(tooFar.ok).toBe(true);
  });

  it('accepts press, scroll, wait, done and give_up', async () => {
    const session = await open('/many');
    expect(await session.act({ type: 'press', key: 'Tab' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'scroll', direction: 'down' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'scroll', direction: 'up' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'wait', ms: 20 })).toEqual({ ok: true, navigated: false });
    expect(await session.act({ type: 'done', reason: 'finished' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'give_up', reason: 'lost' })).toEqual({
      ok: true,
      navigated: false,
    });
  });
});

describe('capture', () => {
  it('collects console, page and network errors until the next observe, and emits $agon_error', async () => {
    const session = await open('/errors');
    const obs = await observeUntil(session, (o) => o.errors.length >= 3);
    expect(obs.errors).toEqual(
      expect.arrayContaining([
        'console.error: boom from console',
        'uncaught exception: kaboom uncaught',
        `http 404: GET ${server.baseUrl}/missing`,
      ]),
    );

    const again = await session.observe();
    expect(again.errors).toEqual([]);

    const events = session.drainEvents();
    const errors = events.filter((e) => e.event === INFERRED_EVENTS.error);
    expect(errors.map((e) => e.properties['kind']).sort()).toEqual(['console', 'exception']);
    expect(errors.every((e) => e.source === 'inferred')).toBe(true);
    expect(errors[0]?.properties['$current_url']).toBe(`${server.baseUrl}/errors`);
    expect(events.filter((e) => e.event === INFERRED_EVENTS.pageview)).toHaveLength(1);
  });

  it('honours capture flags that turn error collection off', async () => {
    const session = await open('/errors', {
      capture: { consoleErrors: false, networkErrors: false },
    });
    await session.act({ type: 'wait', ms: 200 });
    const obs = await session.observe();
    expect(obs.errors).toEqual([]);
    expect(session.drainEvents().filter((e) => e.event === INFERRED_EVENTS.error)).toEqual([]);
  });

  it('intercepts and parses analytics calls without letting them reach the server by default', async () => {
    const eBefore = server.hitCount('/e/');
    const captureBefore = server.hitCount('/capture/');
    const session = await open('/analytics', { capture: { analytics: ['posthog'] } });
    const obs = await observeUntil(session, (o) => o.text.includes('analytics sent'));
    expect(obs.text).toContain('analytics sent');

    const intercepted = session.drainEvents().filter((e) => e.source === 'intercepted');
    expect(intercepted.map((e) => e.event).sort()).toEqual([
      '$pageview',
      'cta_clicked',
      'signup_viewed',
    ]);
    expect(intercepted.every((e) => e.provider === 'posthog')).toBe(true);
    const signup = intercepted.find((e) => e.event === 'signup_viewed');
    expect(signup?.properties).toEqual({
      $distinct_id: 'user-1',
      plan: 'pro',
      distinct_id: 'user-1',
    });
    const cta = intercepted.find((e) => e.event === 'cta_clicked');
    expect(cta?.properties).toEqual({ distinct_id: 'user-1', cta: 'hero' });

    expect(server.hitCount('/e/')).toBe(eBefore);
    expect(server.hitCount('/capture/')).toBe(captureBefore);
  });

  it('blocks beacons and unload-time keepalive calls that would bypass routing', async () => {
    const eBefore = server.hitCount('/e/');
    const captureBefore = server.hitCount('/capture/');
    const session = await open('/beacon', { capture: { analytics: ['posthog'] } });
    const obs = await observeUntil(session, (o) => o.text.includes('beacon sent'));
    // The rerouted beacon is an ordinary fetch now; give interception a moment to see it.
    const drained: EventDraft[] = [];
    for (let i = 0; i < 50 && !drained.some((e) => e.event === 'beacon_event'); i++) {
      drained.push(...session.drainEvents());
      if (!drained.some((e) => e.event === 'beacon_event'))
        await new Promise((r) => setTimeout(r, 100));
    }
    const beacon = drained.find((e) => e.event === 'beacon_event');
    expect(beacon?.source).toBe('intercepted');
    expect(beacon?.properties).toMatchObject({ distinct_id: 'user-9' });
    expect(server.hitCount('/e/')).toBe(eBefore);

    const leave = byName(obs, 'Leave');
    const result = await session.act({ type: 'click', ref: leave.ref });
    expect(result.navigated).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.hitCount('/capture/')).toBe(captureBefore);
    expect(server.hitCount('/e/')).toBe(eBefore);
    await session.close();
  });

  it('forwards analytics calls when forwardAnalytics is true, still capturing them', async () => {
    const eBefore = server.hitCount('/e/');
    const captureBefore = server.hitCount('/capture/');
    const session = await open('/analytics', {
      capture: { analytics: ['posthog'], forwardAnalytics: true },
    });
    await observeUntil(session, (o) => o.text.includes('analytics sent'));

    const intercepted = session.drainEvents().filter((e) => e.source === 'intercepted');
    expect(intercepted.map((e) => e.event).sort()).toEqual([
      '$pageview',
      'cta_clicked',
      'signup_viewed',
    ]);
    expect(server.hitCount('/e/')).toBe(eBefore + 1);
    expect(server.hitCount('/capture/')).toBe(captureBefore + 1);
    expect(server.analyticsBodies.some((body) => body.includes('signup_viewed'))).toBe(true);
  });

  it('leaves analytics endpoints alone when no provider is configured', async () => {
    const eBefore = server.hitCount('/e/');
    const session = await open('/analytics');
    await observeUntil(session, (o) => o.text.includes('analytics sent'));
    expect(session.drainEvents().filter((e) => e.source === 'intercepted')).toEqual([]);
    expect(server.hitCount('/e/')).toBe(eBefore + 1);
  });
});

describe('context setup and lifecycle', () => {
  it('emulates mobile and tablet devices, changing the viewport width', async () => {
    const desktop = await (await open('/viewport')).observe();
    const mobile = await (await open('/viewport', { device: 'mobile' })).observe();
    const tablet = await (await open('/viewport', { device: 'tablet' })).observe();
    expect(desktop.text).toContain('innerWidth=1280');
    expect(mobile.text).toContain('innerWidth=412');
    expect(tablet.text).toContain('innerWidth=712');
  });

  it('sends variant and session headers and applies the locale', async () => {
    const withHeaders = await (
      await open('/headers', { headers: { 'x-agon-test': 'yes' } })
    ).observe();
    expect(withHeaders.text).toContain('x-agon-test=yes');
    expect(withHeaders.text).toContain('x-variant-header=from-variant');

    const german = await (await open('/locale', { locale: 'de-DE' })).observe();
    expect(german.text).toContain('language=de-DE');
  });

  it('takes PNG screenshots', async () => {
    const session = await open('/');
    const png = await session.screenshot();
    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from(png?.subarray(0, 8) ?? [])).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('rejects variants without a url', async () => {
    await expect(
      adapter.open(
        { env: {}, headers: {} },
        {
          sessionId: 'ses_test_00002',
          variant: 'broken',
          startPath: '/',
          viewport: { width: 1280, height: 800 },
          device: 'desktop',
          locale: 'en-US',
          capture: baseCapture,
        },
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('fails to open an unreachable target with an AdapterError', async () => {
    await expect(
      adapter.open(
        { url: 'http://127.0.0.1:9', env: {}, headers: {} },
        {
          sessionId: 'ses_test_00003',
          variant: 'down',
          startPath: '/',
          viewport: { width: 1280, height: 800 },
          device: 'desktop',
          locale: 'en-US',
          capture: baseCapture,
          timeoutMs: 3_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'adapter_error' });
  });

  it('closes idempotently and refuses to work afterwards', async () => {
    const session = await open('/');
    await session.close();
    await session.close();
    expect(await session.screenshot()).toBeUndefined();
    await expect(session.observe()).rejects.toBeInstanceOf(AdapterError);
    await expect(session.act({ type: 'wait', ms: 10 })).rejects.toMatchObject({
      code: 'adapter_error',
    });
    expect(session.drainEvents()).toEqual(expect.any(Array));
  });
});
