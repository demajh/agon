import { ActionSchema, AdapterError, INFERRED_EVENTS, nowIso } from '@agon/spec';
import type {
  ActResult,
  Action,
  AdapterSession,
  AnalyticsProvider,
  Capture,
  EventDraft,
  ObserveOptions,
  Observation,
  TargetKind,
} from '@agon/spec';
import type {
  BrowserContext,
  ConsoleMessage,
  Frame,
  Locator,
  Page,
  Request,
  Response,
  Route,
} from 'playwright';
import {
  isTargetClosedError,
  normalizeKey,
  parseBooleanText,
  resolveNavigationUrl,
  shortErrorMessage,
} from './actions.js';
import {
  analyticsPatternSources,
  matchAnalyticsProvider,
  parseAnalyticsRequest,
} from './analytics.js';
import { analyticsGuard } from './unload-guard.js';
import { z } from 'zod';
import { DEFAULT_MAX_INTERACTIVE, DEFAULT_MAX_TEXT_CHARS, buildObservation } from './observe.js';
import { collectPageState } from './page-script.js';
import type { PageScriptOptions, PageScriptResult } from './page-script.js';

/** Attribute the page script stamps on interactive elements; action refs resolve through it. */
export const AGON_REF_ATTRIBUTE = 'data-agon-ref';

/** Window property the analytics guard calls; see unload-guard.ts. */
export const ANALYTICS_BINDING = '__agonAnalytics';

const ScriptedAnalyticsSchema = z.object({
  url: z.string().min(1),
  method: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  encoding: z.enum(['utf8', 'base64']),
});

const REF_RE = /^e\d+$/;
const MAX_BUFFERED_EVENTS = 5000;
const MAX_PENDING_ERRORS = 50;
const ELEMENT_LOOKUP_TIMEOUT_MS = 1000;
const ANALYTICS_STUB_BODY = '{"status":1}';
/** Resource kinds that are never analytics hits even when their URL matches a provider pattern. */
const SKIPPED_RESOURCE_TYPES = new Set([
  'document',
  'stylesheet',
  'script',
  'font',
  'media',
  'websocket',
  'eventsource',
  'manifest',
  'texttrack',
]);

export interface WebSessionOptions {
  context: BrowserContext;
  capture: Capture;
  startUrl: string;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  settleTimeoutMs: number;
}

interface ElementInfo {
  tag: string;
  type: string;
  disabled: boolean;
  editable: boolean;
  options: { value: string; label: string }[];
}

type Resolved = { locator: Locator; info: ElementInfo } | { error: string };

/** Runs in the page: what the adapter needs to know before acting on an element. */
function describeElement(el: HTMLElement | SVGElement): ElementInfo {
  const tag = el.tagName.toLowerCase();
  const options =
    tag === 'select'
      ? Array.from((el as HTMLSelectElement).options).map((option) => ({
          value: option.value,
          label: (option.label || option.text || '').trim(),
        }))
      : [];
  return {
    tag,
    type: tag === 'input' ? (el as HTMLInputElement).type : '',
    disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    editable: (el as HTMLElement).isContentEditable === true,
    options,
  };
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

const noop = (): undefined => undefined;

export class WebSession implements AdapterSession {
  readonly kind: TargetKind = 'web';

  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly capture: Capture;
  private readonly actionTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly events: EventDraft[] = [];
  private readonly pendingErrors: string[] = [];
  private navigations = 0;
  private lastUrl: string | undefined;
  private unusable = false;
  private contextClosed = false;

  private constructor(page: Page, options: WebSessionOptions) {
    this.context = options.context;
    this.page = page;
    this.capture = options.capture;
    this.actionTimeoutMs = options.actionTimeoutMs;
    this.navigationTimeoutMs = options.navigationTimeoutMs;
    this.settleTimeoutMs = options.settleTimeoutMs;
  }

  /** Creates the page, wires listeners and analytics routes, then loads the start URL. */
  static async open(options: WebSessionOptions): Promise<WebSession> {
    const page = await options.context.newPage();
    const session = new WebSession(page, options);
    session.attachListeners();
    if (session.capture.analytics.length > 0) {
      await page.exposeBinding(ANALYTICS_BINDING, (_source, payload: unknown) =>
        session.handleScriptedAnalytics(payload),
      );
      await page.addInitScript(analyticsGuard, {
        patterns: analyticsPatternSources(session.capture.analytics),
        binding: ANALYTICS_BINDING,
      });
    }
    await session.installAnalyticsRoutes();
    await page.goto(options.startUrl, {
      waitUntil: 'load',
      timeout: options.navigationTimeoutMs,
    });
    await session.settle();
    return session;
  }

  // -------------------------------------------------------------------------
  // AdapterSession
  // -------------------------------------------------------------------------

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    this.assertUsable();
    const maxInteractive = positiveInt(options.maxInteractive) ?? DEFAULT_MAX_INTERACTIVE;
    const maxTextChars = positiveInt(options.maxTextChars) ?? DEFAULT_MAX_TEXT_CHARS;
    const raw = await this.collect(maxInteractive);
    const errors = this.pendingErrors.splice(0);
    return buildObservation(raw, { maxInteractive, maxTextChars, errors, capturedAt: nowIso() });
  }

  async act(action: Action): Promise<ActResult> {
    this.assertUsable();
    const parsed = ActionSchema.safeParse(action);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
      return { ok: false, error: clip(`invalid action: ${detail}`, 200), navigated: false };
    }
    const urlBefore = this.page.url();
    const navigationsBefore = this.navigations;
    const navigated = (): boolean =>
      this.page.url() !== urlBefore || this.navigations > navigationsBefore;
    try {
      const error = await this.perform(parsed.data);
      return error === undefined
        ? { ok: true, navigated: navigated() }
        : { ok: false, error, navigated: navigated() };
    } catch (error) {
      this.rethrowIfGone(error);
      return { ok: false, error: shortErrorMessage(error), navigated: navigated() };
    }
  }

  drainEvents(): EventDraft[] {
    return this.events.splice(0);
  }

  async screenshot(): Promise<Uint8Array | undefined> {
    if (this.unusable || this.page.isClosed()) return undefined;
    try {
      const buffer = await this.page.screenshot({ type: 'png' });
      return new Uint8Array(buffer);
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    this.unusable = true;
    if (this.contextClosed) return;
    this.contextClosed = true;
    await this.context.close().catch(noop);
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  private async collect(maxInteractive: number): Promise<PageScriptResult> {
    const args: PageScriptOptions = {
      refAttribute: AGON_REF_ATTRIBUTE,
      maxElements: maxInteractive + 1,
      maxNameChars: 120,
      maxValueChars: 200,
      maxOptions: 10,
    };
    try {
      return await this.page.evaluate(collectPageState, args);
    } catch (error) {
      this.rethrowIfGone(error);
      // Usually "execution context was destroyed": the page navigated while we were reading it.
      await this.settle();
      try {
        return await this.page.evaluate(collectPageState, args);
      } catch (retryError) {
        this.rethrowIfGone(retryError);
        throw new AdapterError(`observe failed: ${shortErrorMessage(retryError)}`, {
          cause: retryError,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Actions. Each returns an error message for a failed-but-recoverable action, undefined on success.
  // -------------------------------------------------------------------------

  private async perform(action: Action): Promise<string | undefined> {
    switch (action.type) {
      case 'click':
        return this.click(action.ref);
      case 'fill':
        return this.fill(action.ref, action.text);
      case 'select':
        return this.select(action.ref, action.value);
      case 'press':
        await this.page.keyboard.press(normalizeKey(action.key));
        await this.settle();
        return undefined;
      case 'navigate':
        return this.navigate(action.url);
      case 'scroll':
        return this.scroll(action.direction);
      case 'back':
        return this.back();
      case 'wait':
        await this.page.waitForTimeout(action.ms);
        return undefined;
      case 'give_up':
      case 'done':
        return undefined;
    }
  }

  private async resolve(ref: string): Promise<Resolved> {
    if (!REF_RE.test(ref)) {
      return {
        error: `unknown element ref "${ref}"; refs look like e12 and come from the latest observation`,
      };
    }
    const locator = this.page.locator(`[${AGON_REF_ATTRIBUTE}="${ref}"]`).first();
    try {
      const info = await locator.evaluate(describeElement, undefined, {
        timeout: ELEMENT_LOOKUP_TIMEOUT_MS,
      });
      return { locator, info };
    } catch (error) {
      this.rethrowIfGone(error);
      return { error: `${ref} is no longer on the page; observe again` };
    }
  }

  private async click(ref: string): Promise<string | undefined> {
    const resolved = await this.resolve(ref);
    if ('error' in resolved) return resolved.error;
    if (resolved.info.disabled) return `${ref} is disabled`;
    try {
      await resolved.locator.click({ timeout: this.actionTimeoutMs });
    } catch (error) {
      this.rethrowIfGone(error);
      const message = error instanceof Error ? error.message : String(error);
      if (!/outside of the viewport|not visible|intercepts pointer events/i.test(message))
        throw error;
      // The element exists but cannot be reached with a real pointer; a DOM click is what a user
      // tabbing to it with the keyboard would get.
      await resolved.locator.dispatchEvent('click', undefined, { timeout: this.actionTimeoutMs });
    }
    await this.settle();
    return undefined;
  }

  private async fill(ref: string, text: string): Promise<string | undefined> {
    const resolved = await this.resolve(ref);
    if ('error' in resolved) return resolved.error;
    const { locator, info } = resolved;
    if (info.disabled) return `${ref} is disabled`;
    if (info.tag === 'select') return this.selectOption(ref, locator, info, text);
    if (info.tag === 'input' && (info.type === 'checkbox' || info.type === 'radio')) {
      const checked = parseBooleanText(text);
      if (checked === undefined) {
        return `${ref} is a ${info.type}; fill it with "true" or "false", or click it`;
      }
      await locator.setChecked(checked, { timeout: this.actionTimeoutMs });
      return undefined;
    }
    if (info.tag === 'input' && info.type === 'file') return 'file uploads are not supported';
    if (info.tag === 'input' || info.tag === 'textarea' || info.editable) {
      await locator.fill(text, { timeout: this.actionTimeoutMs });
      return undefined;
    }
    return `${ref} is a <${info.tag}> and cannot be typed into; try click`;
  }

  private async select(ref: string, value: string): Promise<string | undefined> {
    const resolved = await this.resolve(ref);
    if ('error' in resolved) return resolved.error;
    if (resolved.info.disabled) return `${ref} is disabled`;
    if (resolved.info.tag !== 'select') {
      return `${ref} is a <${resolved.info.tag}>, not a <select>; use click or fill`;
    }
    return this.selectOption(ref, resolved.locator, resolved.info, value);
  }

  private async selectOption(
    ref: string,
    locator: Locator,
    info: ElementInfo,
    wanted: string,
  ): Promise<string | undefined> {
    const target = wanted.trim();
    const match =
      info.options.find((option) => option.value === target || option.label === target) ??
      info.options.find(
        (option) =>
          option.label.toLowerCase() === target.toLowerCase() ||
          option.value.toLowerCase() === target.toLowerCase(),
      );
    if (!match) {
      const labels = info.options.map((option) => option.label || option.value).join(', ');
      return clip(`no option "${wanted}" in ${ref}; options: ${labels}`, 300);
    }
    await locator.selectOption({ value: match.value }, { timeout: this.actionTimeoutMs });
    await this.settle(Math.min(this.settleTimeoutMs, 500));
    return undefined;
  }

  private async navigate(target: string): Promise<string | undefined> {
    let url: URL;
    try {
      url = resolveNavigationUrl(target, this.page.url());
    } catch (error) {
      return shortErrorMessage(error);
    }
    try {
      await this.page.goto(url.href, { waitUntil: 'load', timeout: this.navigationTimeoutMs });
    } catch (error) {
      this.rethrowIfGone(error);
      return `navigation to ${url.href} failed: ${shortErrorMessage(error, 120)}`;
    }
    await this.settle();
    return undefined;
  }

  private async scroll(direction: 'down' | 'up'): Promise<undefined> {
    const viewport = this.page.viewportSize();
    const width = viewport?.width ?? 1280;
    const height = viewport?.height ?? 800;
    const delta = Math.round(height * 0.85) * (direction === 'down' ? 1 : -1);
    try {
      await this.page.mouse.move(Math.round(width / 2), Math.round(height / 2));
      await this.page.mouse.wheel(0, delta);
    } catch (error) {
      this.rethrowIfGone(error);
      await this.page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'instant' }), delta);
    }
    await this.page.waitForTimeout(150);
    return undefined;
  }

  private async back(): Promise<string | undefined> {
    const before = this.page.url();
    const response = await this.page.goBack({
      waitUntil: 'load',
      timeout: this.navigationTimeoutMs,
    });
    if (response === null && this.page.url() === before) return 'no previous page in history';
    await this.settle();
    return undefined;
  }

  /** Waits for load, then for the network to go idle, never longer than `capMs` in total. */
  private async settle(capMs = this.settleTimeoutMs): Promise<void> {
    const deadline = Date.now() + capMs;
    await this.page.waitForLoadState('load', { timeout: capMs }).catch(noop);
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await this.page.waitForLoadState('networkidle', { timeout: remaining }).catch(noop);
    }
  }

  // -------------------------------------------------------------------------
  // Capture: errors, inferred events, analytics interception
  // -------------------------------------------------------------------------

  private attachListeners(): void {
    this.page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error' || !this.capture.consoleErrors) return;
      const text = message.text();
      // Chromium echoes every failed resource load to the console; the network listeners below
      // already report those with the status code, so skip the duplicate.
      if (text.startsWith('Failed to load resource')) return;
      this.pushError(`console.error: ${text}`);
      this.pushEvent(this.errorDraft('console', text, message.location().url));
    });
    this.page.on('pageerror', (error: Error) => {
      if (!this.capture.consoleErrors) return;
      this.pushError(`uncaught exception: ${error.message}`);
      this.pushEvent(this.errorDraft('exception', error.message));
    });
    this.page.on('requestfailed', (request: Request) => {
      if (!this.capture.networkErrors) return;
      const reason = request.failure()?.errorText ?? 'failed';
      if (reason.includes('ERR_ABORTED')) return;
      this.pushError(`request failed: ${request.method()} ${request.url()} (${reason})`);
    });
    this.page.on('response', (response: Response) => {
      if (!this.capture.networkErrors || response.status() < 400) return;
      if (/\/favicon\.ico(?:\?|$)/.test(response.url())) return;
      this.pushError(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    });
    this.page.on('framenavigated', (frame: Frame) => {
      if (frame !== this.page.mainFrame()) return;
      const url = frame.url();
      if (!/^https?:/i.test(url)) return;
      this.navigations += 1;
      this.pushEvent(this.pageviewDraft(url));
      this.lastUrl = url;
    });
    this.page.on('close', () => {
      this.unusable = true;
    });
    this.context.on('close', () => {
      this.unusable = true;
      this.contextClosed = true;
    });
  }

  /**
   * Analytics calls the page made through fetch/sendBeacon arrive here from the injected guard
   * instead of the network. Parse them like routed requests; forward from Node when asked to.
   */
  private async handleScriptedAnalytics(payload: unknown): Promise<void> {
    const parsed = ScriptedAnalyticsSchema.safeParse(payload);
    if (!parsed.success) return;
    const { url, method, headers, body, encoding } = parsed.data;
    const provider = matchAnalyticsProvider(url, this.capture.analytics);
    if (provider === undefined) return;
    const buffer =
      body === null ? null : Buffer.from(body, encoding === 'base64' ? 'base64' : 'utf8');
    const drafts = parseAnalyticsRequest(
      { provider, url, method, headers, body: buffer },
      nowIso(),
    );
    for (const draft of drafts) this.pushEvent(draft);
    if (this.capture.forwardAnalytics) {
      await fetch(url, {
        method,
        headers,
        body: buffer === null ? undefined : new Uint8Array(buffer),
      }).catch(noop);
    }
  }

  private async installAnalyticsRoutes(): Promise<void> {
    const providers = this.capture.analytics;
    if (providers.length === 0) return;
    await this.context.route(
      (url) => matchAnalyticsProvider(url.href, providers) !== undefined,
      (route) => this.handleAnalyticsRoute(route, providers),
    );
  }

  private async handleAnalyticsRoute(
    route: Route,
    providers: readonly AnalyticsProvider[],
  ): Promise<void> {
    const request = route.request();
    const provider = SKIPPED_RESOURCE_TYPES.has(request.resourceType())
      ? undefined
      : matchAnalyticsProvider(request.url(), providers);
    if (provider === undefined) {
      await route.fallback().catch(noop);
      return;
    }
    const drafts = parseAnalyticsRequest(
      {
        provider,
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        body: request.postDataBuffer(),
      },
      nowIso(),
    );
    for (const draft of drafts) this.pushEvent(draft);
    if (this.capture.forwardAnalytics) {
      await route.continue().catch(noop);
    } else {
      await route
        .fulfill({ status: 200, contentType: 'application/json', body: ANALYTICS_STUB_BODY })
        .catch(noop);
    }
  }

  private pageviewDraft(url: string): EventDraft {
    const properties: Record<string, unknown> = { $current_url: url };
    try {
      const parsed = new URL(url);
      properties['$host'] = parsed.host;
      properties['$pathname'] = parsed.pathname;
    } catch {
      // keep $current_url only
    }
    if (this.lastUrl !== undefined) properties['$referrer'] = this.lastUrl;
    return { timestamp: nowIso(), event: INFERRED_EVENTS.pageview, source: 'inferred', properties };
  }

  private errorDraft(
    kind: 'console' | 'exception',
    message: string,
    sourceUrl?: string,
  ): EventDraft {
    const properties: Record<string, unknown> = {
      kind,
      message: clip(message, 500),
      $current_url: this.page.url(),
    };
    if (sourceUrl) properties['source_url'] = sourceUrl;
    return { timestamp: nowIso(), event: INFERRED_EVENTS.error, source: 'inferred', properties };
  }

  private pushEvent(draft: EventDraft): void {
    if (this.events.length >= MAX_BUFFERED_EVENTS) this.events.shift();
    this.events.push(draft);
  }

  private pushError(message: string): void {
    if (this.pendingErrors.length < MAX_PENDING_ERRORS) {
      this.pendingErrors.push(clip(message, 500));
    } else if (this.pendingErrors.length === MAX_PENDING_ERRORS) {
      this.pendingErrors.push('… further errors omitted');
    }
  }

  // -------------------------------------------------------------------------
  // Liveness
  // -------------------------------------------------------------------------

  private assertUsable(): void {
    if (this.unusable || this.page.isClosed()) {
      this.unusable = true;
      throw new AdapterError('web session is closed');
    }
  }

  /** Converts "the page/context/browser is gone" failures into AdapterError; returns otherwise. */
  private rethrowIfGone(error: unknown): void {
    if (this.unusable || this.page.isClosed() || isTargetClosedError(error)) {
      this.unusable = true;
      throw new AdapterError(
        `web session is no longer available: ${shortErrorMessage(error, 120)}`,
        {
          cause: error,
        },
      );
    }
  }
}
