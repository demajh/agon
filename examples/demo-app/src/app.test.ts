import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { App } from './context.js';
import { DEV_VERIFICATION_CODE, TAKEN_EMAIL } from './store.js';
import type { LoggedEvent } from './store.js';
import { VARIANTS } from './types.js';

/** A minimal browser: carries cookies between `app.request()` calls, never follows redirects. */
interface Client {
  cookies: Map<string, string>;
  get(path: string): Promise<Response>;
  post(path: string, form?: Record<string, string>): Promise<Response>;
  postJson(path: string, body?: unknown): Promise<Response>;
}

function client(app: App): Client {
  const cookies = new Map<string, string>();
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (cookies.size > 0) {
      headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const res = await app.request(path, { ...init, headers });
    for (const header of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (expired || value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
    return res;
  }
  return {
    cookies,
    get: (path) => request(path),
    post: (path, form = {}) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      }),
    postJson: (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

const SIGNUP = { email: 'ana@example.com', password: 'Str0ngpass', company: 'Ana Co' };

async function events(c: Client, name?: string): Promise<LoggedEvent[]> {
  const res = await c.get(name ? `/__events?event=${name}` : '/__events');
  expect(res.status).toBe(200);
  return (await res.json()) as LoggedEvent[];
}

function location(res: Response): string | null {
  return res.headers.get('location');
}

describe('marketing pages', () => {
  for (const variant of VARIANTS) {
    it(`renders / and /pricing for ${variant}`, async () => {
      const c = client(createApp({ variant }));

      const home = await c.get('/');
      expect(home.status).toBe(200);
      const homeHtml = await home.text();
      expect(homeHtml).toContain('<html lang="en"');
      expect(homeHtml).toContain(`data-variant="${variant}"`);
      expect(homeHtml).toContain('Ledgerly');
      expect(homeHtml).toContain('Start free');
      expect(homeHtml).toContain('<script src="/static/analytics.js"></script>');
      expect(homeHtml).toContain(`posthog.register({"variant":"${variant}"})`);

      const pricing = await c.get('/pricing');
      expect(pricing.status).toBe(200);
      const pricingHtml = await pricing.text();
      for (const tier of ['Starter', 'Team', 'Business']) expect(pricingHtml).toContain(tier);
      expect(pricingHtml).toContain('Frequently asked questions');
      // pricing_viewed is logged server-side and handed to the browser shim on the same page.
      expect(pricingHtml).toContain('posthog.capture("pricing_viewed"');
      const logged = await events(c, 'pricing_viewed');
      expect(logged).toHaveLength(1);
      expect(logged[0]?.properties['variant']).toBe(variant);
    });
  }

  it('renders /docs and an accessible 404 page', async () => {
    const c = client(createApp({ variant: 'control' }));
    expect((await c.get('/docs')).status).toBe(200);
    const missing = await c.get('/nope');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Page not found');
  });
});

describe('signup validation', () => {
  it('rejects an invalid email, a weak password, and a missing company', async () => {
    const c = client(createApp({ variant: 'control' }));
    const res = await c.post('/signup', { email: 'not-an-email', password: 'short', company: '' });
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain('Enter a valid email address');
    expect(page).toContain('at least 8 characters');
    expect(page).toContain('Enter your company name');
    expect(page).toContain('role="alert"');
    expect(page).toContain('aria-invalid="true"');
    expect(page).toContain('value="not-an-email"');
    expect(await events(c, 'signup_completed')).toHaveLength(0);
  });

  it('rejects an email that is already registered', async () => {
    const c = client(createApp({ variant: 'treatment' }));
    const res = await c.post('/signup', { ...SIGNUP, email: TAKEN_EMAIL });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('already exists');
  });

  it('logs signup_started once when the form is shown', async () => {
    const c = client(createApp({ variant: 'control' }));
    const form = await c.get('/signup');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("posthog.capture('signup_started')");
    await c.get('/signup');
    expect(await events(c, 'signup_started')).toHaveLength(1);
  });
});

describe('onboarding flows', () => {
  it('control: five onboarding POSTs after signup reach project_created', async () => {
    const c = client(createApp({ variant: 'control' }));
    let res = await c.post('/signup', SIGNUP);
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/onboarding/verify');

    // The dashboard and later steps are gated until onboarding is complete, in order.
    expect(location(await c.get('/app'))).toBe('/onboarding/verify');
    expect(location(await c.get('/onboarding/project'))).toBe('/onboarding/verify');

    res = await c.get('/onboarding/verify');
    expect(res.status).toBe(200);
    const verifyPage = await res.text();
    expect(verifyPage).toContain('Step 2 of 6');
    expect(verifyPage).toContain(`Dev: your code is <code>${DEV_VERIFICATION_CODE}</code>`);

    res = await c.post('/onboarding/verify', { code: '000000' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('did not match');

    res = await c.post('/onboarding/verify', { code: DEV_VERIFICATION_CODE }); // 1
    expect(location(res)).toBe('/onboarding/profile');
    res = await c.post('/onboarding/profile', { role: 'owner', team_size: '2-10' }); // 2
    expect(location(res)).toBe('/onboarding/connect-bank');
    res = await c.post('/onboarding/connect-bank/skip'); // 3
    expect(location(res)).toBe('/onboarding/invite');
    res = await c.post('/onboarding/invite', { invite_1: 'sam@example.com', invite_2: '' }); // 4
    expect(location(res)).toBe('/onboarding/project');
    res = await c.post('/onboarding/project', { name: 'Ana Co Books', currency: 'USD' }); // 5
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/app?welcome=1');

    const log = await events(c);
    expect(log.map((e) => e.event)).toEqual([
      'signup_completed',
      'onboarding_step_completed',
      'onboarding_step_completed',
      'onboarding_skipped',
      'onboarding_step_completed',
      'onboarding_step_completed',
      'project_created',
    ]);
    expect(
      log.filter((e) => e.event === 'onboarding_step_completed').map((e) => e.properties['step']),
    ).toEqual(['verify', 'profile', 'invite', 'project']);
    expect(log.find((e) => e.event === 'onboarding_skipped')?.properties['step']).toBe(
      'connect-bank',
    );
    expect(log.find((e) => e.event === 'project_created')?.properties).toMatchObject({
      variant: 'control',
      source: 'onboarding',
    });
    expect(log.every((e) => e.properties['variant'] === 'control')).toBe(true);
    const userId = log[0]?.distinct_id ?? '';
    expect(userId).toMatch(/^usr_/);
    expect(log.every((e) => e.distinct_id === userId)).toBe(true);

    res = await c.get('/app?welcome=1');
    expect(res.status).toBe(200);
    const dashboard = await res.text();
    expect(dashboard).toContain('Ana Co Books');
    expect(dashboard).toContain('Your first project is ready');
    // Queued client events are flushed into the first page rendered after the redirects.
    expect(dashboard).toContain('posthog.capture("project_created"');
    expect(dashboard).toContain('posthog.capture("dashboard_viewed"');
    expect(dashboard).toContain(`posthog.identify("${userId}"`);
    // Only the skipped bank remains as a suggestion.
    expect(dashboard).toContain('Connect a bank');
    expect(dashboard).not.toContain('Complete profile');
    expect(dashboard).not.toContain('Verify email');
  });

  it('control: an empty project form is rejected', async () => {
    const c = client(createApp({ variant: 'control' }));
    await c.post('/signup', SIGNUP);
    await c.post('/onboarding/verify', { code: DEV_VERIFICATION_CODE });
    await c.post('/onboarding/profile', { role: 'owner', team_size: '1' });
    await c.post('/onboarding/connect-bank', { bank: 'meridian' });
    await c.post('/onboarding/invite');
    const res = await c.post('/onboarding/project');
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain('Name your project');
    expect(page).toContain('Choose a base currency');
    expect(await events(c, 'project_created')).toHaveLength(0);
    expect(await events(c, 'onboarding_skipped')).toHaveLength(0);
  });

  it('treatment: one POST after signup reaches project_created', async () => {
    const c = client(createApp({ variant: 'treatment' }));
    let res = await c.post('/signup', SIGNUP);
    expect(location(res)).toBe('/onboarding/project');

    res = await c.get('/onboarding/project');
    expect(res.status).toBe(200);
    const form = await res.text();
    expect(form).toContain('value="Ana Co Books"');
    expect(form).toContain('Create project');
    expect(form).not.toContain('Onboarding progress');

    res = await c.post('/onboarding/project', { name: 'Ana Co Books', currency: 'USD' }); // 1
    expect(location(res)).toBe('/app?welcome=1');

    const log = await events(c);
    expect(log.map((e) => e.event)).toEqual([
      'signup_completed',
      'onboarding_step_completed',
      'project_created',
    ]);
    expect(log.find((e) => e.event === 'project_created')?.properties['variant']).toBe('treatment');

    const dashboard = await (await c.get('/app')).text();
    expect(dashboard).toContain('Finish setting up');
    for (const cta of ['Verify email', 'Complete profile', 'Connect a bank', 'Invite teammates']) {
      expect(dashboard).toContain(cta);
    }
    // Optional steps work from the dashboard and return to it.
    res = await c.post('/onboarding/profile', { role: 'finance', team_size: '11-50' });
    expect(location(res)).toBe('/app');
    res = await c.post('/onboarding/verify', { code: DEV_VERIFICATION_CODE });
    expect(location(res)).toBe('/app');
    expect(location(await c.get('/onboarding/verify'))).toBe('/app');
  });

  it('treatment: an empty submission falls back to the defaults', async () => {
    const c = client(createApp({ variant: 'treatment' }));
    await c.post('/signup', SIGNUP);
    expect(location(await c.post('/onboarding/project'))).toBe('/app?welcome=1');
    const dashboard = await (await c.get('/app')).text();
    expect(dashboard).toContain('Ana Co Books');
    expect(dashboard).toContain('USD');
  });

  it('creates further projects from /projects/new and renders them', async () => {
    const c = client(createApp({ variant: 'treatment' }));
    await c.post('/signup', SIGNUP);
    await c.post('/onboarding/project');
    const res = await c.post('/projects/new', { name: 'Side Hustle', currency: 'EUR' });
    const target = location(res) ?? '';
    expect(target).toMatch(/^\/projects\/prj_/);
    const page = await (await c.get(target)).text();
    expect(page).toContain('Side Hustle');
    expect(page).toContain('Base currency EUR');
    const created = await events(c, 'project_created');
    expect(created).toHaveLength(2);
    expect(created[1]?.properties['source']).toBe('projects_new');
    expect((await c.get('/projects/prj_missing')).status).toBe(404);
  });

  it('settings saves the profile and deletes the account only with confirmation', async () => {
    const c = client(createApp({ variant: 'treatment' }));
    await c.post('/signup', SIGNUP);
    await c.post('/onboarding/project');
    expect((await c.get('/app/settings')).status).toBe(200);
    let res = await c.post('/app/settings/profile', { role: 'bookkeeper', team_size: '51+' });
    expect(location(res)).toBe('/app/settings?saved=1');
    expect(await (await c.get('/app/settings?saved=1')).text()).toContain(
      'Your changes were saved',
    );
    res = await c.post('/app/settings/delete');
    expect(res.status).toBe(400);
    res = await c.post('/app/settings/delete', { confirm_delete: 'yes' });
    expect(location(res)).toBe('/');
    expect(location(await c.get('/app'))).toBe('/login?next=%2Fapp');
  });
});

describe('variant override', () => {
  it('?variant=treatment switches a control process to the treatment flow via a cookie', async () => {
    const c = client(createApp({ variant: 'control' }));
    let res = await c.get('/?variant=treatment');
    expect(res.status).toBe(200);
    expect(c.cookies.get('ledgerly_variant')).toBe('treatment');
    expect(await res.text()).toContain('data-variant="treatment"');

    res = await c.post('/signup', SIGNUP);
    expect(location(res)).toBe('/onboarding/project');
    const health = (await (await c.get('/healthz')).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, variant: 'treatment', defaultVariant: 'control' });

    // An empty ?variant= clears the override.
    res = await c.get('/pricing?variant=');
    expect(c.cookies.has('ledgerly_variant')).toBe(false);
    expect(await res.text()).toContain('data-variant="control"');
  });
});

describe('test hooks', () => {
  it('/__test-user returns working credentials and /__reset wipes everything', async () => {
    const app = createApp({ variant: 'control' });
    const c = client(app);

    const created = await c.postJson('/__test-user');
    expect(created.status).toBe(201);
    const creds = (await created.json()) as Record<string, string>;
    expect(creds['email']).toMatch(/@example\.com$/);
    expect(creds['password']?.length ?? 0).toBeGreaterThan(8);
    expect(creds['loginUrl']).toBe('/login');

    let res = await c.post('/login', { email: creds['email'] ?? '', password: 'wrong' });
    expect(res.status).toBe(400);
    res = await c.post('/login', {
      email: creds['email'] ?? '',
      password: creds['password'] ?? '',
    });
    expect(location(res)).toBe('/app');
    // Already verified, so control onboarding resumes at the profile step.
    expect(location(await c.get('/app'))).toBe('/onboarding/profile');

    const onboarded = (await (
      await c.postJson('/__test-user', { onboarded: true, company: 'Fixture LLC' })
    ).json()) as Record<string, string>;
    const c2 = client(app);
    await c2.post('/login', {
      email: onboarded['email'] ?? '',
      password: onboarded['password'] ?? '',
    });
    res = await c2.get('/app');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Fixture LLC Books');
    // Fixture creation does not pollute the event log.
    expect(await events(c, 'project_created')).toHaveLength(0);

    res = await c.postJson('/__reset');
    expect(res.status).toBe(200);
    expect(await events(c)).toEqual([]);
    res = await c.post('/login', {
      email: creds['email'] ?? '',
      password: creds['password'] ?? '',
    });
    expect(res.status).toBe(400);
    expect(location(await c2.get('/app'))).toBe('/login?next=%2Fapp');
  });

  it('/__test-user rejects a non-object body and duplicate emails', async () => {
    const c = client(createApp({ variant: 'control' }));
    expect((await c.postJson('/__test-user', [1, 2])).status).toBe(400);
    expect((await c.postJson('/__test-user', { email: TAKEN_EMAIL })).status).toBe(409);
  });

  it('/healthz reports the variant', async () => {
    const res = await createApp({ variant: 'treatment' }).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, variant: 'treatment' });
  });
});

describe('analytics shim', () => {
  it('is served with the injected PostHog host and both wire formats', async () => {
    const app = createApp({
      variant: 'control',
      posthogHost: 'https://analytics.example.test/',
      posthogKey: 'phc_test',
    });
    const res = await app.request('/static/analytics.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const script = await res.text();
    expect(script).toContain('"https://analytics.example.test"'); // trailing slash stripped
    expect(script).toContain('"phc_test"');
    expect(script).toContain("'/e/?ip=1&_='");
    expect(script).toContain("'/capture/'");
    expect(script).toContain('window.posthog');
    expect(() => new Function(script)).not.toThrow();
  });

  it('defaults to the US PostHog cloud host', async () => {
    const res = await createApp({ variant: 'control' }).request('/static/analytics.js');
    expect(await res.text()).toContain('"https://us.i.posthog.com"');
  });
});
