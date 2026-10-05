import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import { DEFAULT_POSTHOG_HOST, DEFAULT_POSTHOG_KEY, renderAnalyticsScript } from './analytics.js';
import { renderPage } from './context.js';
import type { App, AppContext, AppEnv, Deps, ResolvedOptions } from './context.js';
import { ONBOARDING_STEPS, isOnboardingStep, nextRequiredStep } from './onboarding.js';
import { registerAppRoutes } from './pages/app.js';
import { registerAuthRoutes } from './pages/auth.js';
import { errorBody, notFoundBody } from './pages/errors.js';
import { registerMarketingRoutes } from './pages/marketing.js';
import { registerOnboardingRoutes } from './pages/onboarding.js';
import { Store } from './store.js';
import { isVariant } from './types.js';
import type { AppOptions } from './types.js';

export const SESSION_COOKIE = 'ledgerly_sid';
export const VARIANT_COOKIE = 'ledgerly_variant';
const VARIANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Builds the Ledgerly demo app. One process serves one variant by default; `?variant=` on any URL
 * switches a single browser to the other variant through a cookie, for single-process demos.
 */
export function createApp(options: AppOptions): App {
  const resolved: ResolvedOptions = {
    variant: options.variant,
    posthogHost: (options.posthogHost ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, ''),
    posthogKey: options.posthogKey ?? DEFAULT_POSTHOG_KEY,
    sessionSecret: options.sessionSecret ?? randomBytes(32).toString('hex'),
    now: options.now ?? (() => new Date()),
  };
  const store = new Store(resolved.now);
  const deps: Deps = { store, options: resolved, startedAt: Date.now() };
  const analyticsScript = renderAnalyticsScript(resolved);

  const app = new Hono<AppEnv>();
  app.use('*', resolveVariant(resolved));
  registerInfraRoutes(app, deps, analyticsScript);
  app.use('*', loadSession(deps));
  app.use('*', guardAccess(deps));
  registerMarketingRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerOnboardingRoutes(app, deps);
  registerAppRoutes(app, deps);

  app.notFound((c) =>
    renderPage(c, { title: 'Page not found', body: notFoundBody(c.req.path) }, 404),
  );
  app.onError((error, c) =>
    renderPage(c, { title: 'Something went wrong', body: errorBody(error.message) }, 500),
  );
  return app;
}

/** Process default, overridden per browser by `?variant=` (stored in a cookie). `?variant=` alone clears it. */
function resolveVariant(options: ResolvedOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requested = c.req.query('variant');
    let variant = options.variant;
    if (requested !== undefined) {
      if (isVariant(requested)) {
        variant = requested;
        setCookie(c, VARIANT_COOKIE, requested, {
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
          maxAge: VARIANT_COOKIE_MAX_AGE,
        });
      } else {
        deleteCookie(c, VARIANT_COOKIE, { path: '/' });
      }
    } else {
      const fromCookie = getCookie(c, VARIANT_COOKIE);
      if (isVariant(fromCookie)) variant = fromCookie;
    }
    c.set('variant', variant);
    await next();
  };
}

/** Finds or starts the visitor's session from a signed cookie. Infrastructure routes skip this. */
function loadSession(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isInfraPath(c.req.path)) {
      c.set('session', undefined);
      c.set('user', undefined);
      await next();
      return;
    }
    const secret = deps.options.sessionSecret;
    const signed = await getSignedCookie(c, secret, SESSION_COOKIE);
    let session = typeof signed === 'string' ? deps.store.getSession(signed) : undefined;
    if (!session) {
      session = deps.store.createSession();
      await setSignedCookie(c, SESSION_COOKIE, session.id, secret, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
    const user = session.userId ? deps.store.getUser(session.userId) : undefined;
    if (session.userId && !user) session.userId = undefined;
    c.set('session', session);
    c.set('user', user);
    await next();
  };
}

/**
 * Login and onboarding gates:
 *  - /app, /projects and /onboarding need a user;
 *  - /app and /projects redirect into onboarding until the variant's required steps are done;
 *  - control walks its steps in order; a verified user never sees the verify step again.
 */
function guardAccess(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    const inApp = path === '/app' || path.startsWith('/app/') || path.startsWith('/projects');
    const inOnboarding = path.startsWith('/onboarding/');
    if (!inApp && !inOnboarding) {
      await next();
      return;
    }
    const user = c.get('user');
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(path)}`, 303);

    const variant = c.get('variant');
    const required = nextRequiredStep(user, variant, deps.store);
    if (inApp && required) return c.redirect(`/onboarding/${required}`, 303);

    const step = path.split('/')[2];
    if (isOnboardingStep(step)) {
      if (step === 'verify' && user.verified) {
        return c.redirect(required ? `/onboarding/${required}` : '/app', 303);
      }
      if (
        variant === 'control' &&
        required &&
        ONBOARDING_STEPS.indexOf(step) > ONBOARDING_STEPS.indexOf(required)
      ) {
        return c.redirect(`/onboarding/${required}`, 303);
      }
    }
    await next();
  };
}

function isInfraPath(path: string): boolean {
  return path === '/healthz' || path.startsWith('/static/') || path.startsWith('/__');
}

/** Health, the analytics shim, and the test hooks Agon's session setup and the test-suite use. */
function registerInfraRoutes(app: App, deps: Deps, analyticsScript: string): void {
  const { store } = deps;

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'ledgerly-demo',
      variant: c.get('variant'),
      defaultVariant: deps.options.variant,
      uptimeMs: Date.now() - deps.startedAt,
    }),
  );

  app.get('/static/analytics.js', (c) =>
    c.body(analyticsScript, 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    }),
  );

  app.post('/__reset', (c) => {
    store.reset();
    return c.json({ ok: true });
  });

  app.post('/__test-user', async (c) => {
    const body = await readJsonObject(c);
    if (!body) return c.json({ error: 'request body must be a JSON object' }, 400);
    const token = randomBytes(4).toString('hex');
    const email = optionalString(body, 'email') ?? `agon-${token}@example.com`;
    if (store.findUserByEmail(email))
      return c.json({ error: `user already exists: ${email}` }, 409);
    const company = optionalString(body, 'company') ?? `Agon Test ${token}`;
    const password = `Agon-${randomBytes(6).toString('hex')}-1`;
    const variant = c.get('variant');
    const user = store.createUser({
      email,
      password,
      company,
      variant,
      verified: body['verified'] !== false,
    });
    if (body['onboarded'] === true) {
      user.profile = { role: 'owner', teamSize: '2-10' };
      user.bankSkipped = true;
      user.inviteStepDone = true;
      store.createProject({ userId: user.id, name: `${company} Books`, currency: 'USD', variant });
    }
    return c.json({ email, password, loginUrl: '/login' }, 201);
  });

  app.get('/__events', (c) => {
    const name = c.req.query('event');
    const events = name ? store.events.filter((e) => e.event === name) : [...store.events];
    return c.json(events);
  });
}

async function readJsonObject(c: AppContext): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
