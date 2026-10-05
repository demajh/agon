import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { layout } from './html.js';
import type { Page } from './html.js';
import type { Session, Store, User } from './store.js';
import type { Variant } from './types.js';

export interface ResolvedOptions {
  variant: Variant;
  posthogHost: string;
  posthogKey: string;
  sessionSecret: string;
  now: () => Date;
}

/** What every route handler needs, passed explicitly instead of through module state. */
export interface Deps {
  store: Store;
  options: ResolvedOptions;
  startedAt: number;
}

export interface AppVariables {
  /** Variant in effect for this request: the process default unless overridden by cookie. */
  variant: Variant;
  /** Undefined for infrastructure routes (/healthz, /static, /__*) that never touch sessions. */
  session: Session | undefined;
  user: User | undefined;
}

export type AppEnv = { Variables: AppVariables };
export type AppContext = Context<AppEnv>;
export type App = Hono<AppEnv>;

/** Renders a page inside the layout and flushes queued client-side events into it. */
export function renderPage(
  c: AppContext,
  page: Page,
  status: ContentfulStatusCode = 200,
): Response | Promise<Response> {
  const session = c.get('session');
  const clientEvents = session ? session.pendingClientEvents.splice(0) : [];
  return c.html(
    layout(
      { variant: c.get('variant'), user: c.get('user'), path: c.req.path, clientEvents },
      page,
    ),
    status,
  );
}

export interface TrackOptions {
  /** Also queue the event for the browser shim on the next rendered page (default true). */
  client?: boolean;
}

/**
 * Records a product event in the server-side log (GET /__events) and, by default, queues it so the
 * browser emits the same event through the PostHog shim on the next page it renders.
 */
export function track(
  c: AppContext,
  deps: Deps,
  event: string,
  properties: Record<string, unknown> = {},
  options: TrackOptions = {},
): void {
  const session = c.get('session');
  const user = c.get('user');
  const distinctId = user?.id ?? (session ? `anon_${session.id}` : 'anonymous');
  const logged: Record<string, unknown> = {
    variant: c.get('variant'),
    $current_url: c.req.url,
    $pathname: c.req.path,
    ...properties,
  };
  if (session) logged['session_id'] = session.id;
  deps.store.logEvent(event, distinctId, logged);
  if (options.client !== false && session) {
    session.pendingClientEvents.push({ event, properties: { ...properties } });
  }
}

/** The authenticated user; routes behind the auth guard may assume one exists. */
export function currentUser(c: AppContext): User {
  const user = c.get('user');
  if (!user) throw new Error('route requires an authenticated user');
  return user;
}

/** Form fields as trimmed strings (passwords untouched). Non-string parts are ignored. */
export async function readForm(c: AppContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return out;
  }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue;
    out[key] = key.includes('password') ? value : value.trim();
  }
  return out;
}

/** Accepts only same-origin paths for post-login redirects. */
export function safeRedirectTarget(value: string | undefined, fallback = '/app'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}
