import { chromium } from 'playwright';
import type { Browser, LaunchOptions } from 'playwright';
import { AdapterError, AgonError } from '@agon/spec';
import type { Adapter, AdapterSession, OpenOptions, VariantSpec } from '@agon/spec';
import { shortErrorMessage } from './actions.js';
import { deviceContextOptions } from './devices.js';
import { WebSession } from './session.js';

export const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 1_500;

export interface WebAdapterOptions {
  /** Run Chromium headless. Default true. */
  headless?: boolean;
  /** Slow every Playwright operation down by this many milliseconds (debugging aid). */
  slowMo?: number;
  /** Timeout for click/fill/select actionability. Default 10 s. */
  actionTimeoutMs?: number;
  /** Timeout for navigations, unless `OpenOptions.timeoutMs` overrides it per session. Default 30 s. */
  navigationTimeoutMs?: number;
  /** Cap on the post-action wait for load / network idle. Default 1.5 s. */
  settleTimeoutMs?: number;
  /** Accept self-signed certificates (preview environments). Default true. */
  ignoreHTTPSErrors?: boolean;
  /** Extra Chromium launch options, e.g. `executablePath` or `channel`. */
  launchOptions?: Omit<LaunchOptions, 'headless' | 'slowMo'>;
}

export interface WebAdapter extends Adapter {
  readonly kind: 'web';
  /** Closes the shared browser. Sessions opened afterwards launch a fresh one. */
  dispose(): Promise<void>;
}

/**
 * The Playwright web adapter. One Chromium per adapter (launched lazily on the first `open`), one
 * isolated BrowserContext per session with the persona's device, viewport, locale and headers.
 */
export function createWebAdapter(options: WebAdapterOptions = {}): WebAdapter {
  const headless = options.headless ?? true;
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const defaultNavigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const ignoreHTTPSErrors = options.ignoreHTTPSErrors ?? true;

  let browserPromise: Promise<Browser> | undefined;

  const launch = (): Promise<Browser> => {
    if (browserPromise === undefined) {
      const launching: Promise<Browser> = chromium
        .launch({
          ...options.launchOptions,
          headless,
          ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
        })
        .then((browser) => {
          browser.on('disconnected', () => {
            if (browserPromise === launching) browserPromise = undefined;
          });
          return browser;
        })
        .catch((error: unknown) => {
          if (browserPromise === launching) browserPromise = undefined;
          throw new AdapterError(`failed to launch chromium: ${shortErrorMessage(error)}`, {
            cause: error,
          });
        });
      browserPromise = launching;
    }
    return browserPromise;
  };

  return {
    kind: 'web',

    async open(variant: VariantSpec, openOptions: OpenOptions): Promise<AdapterSession> {
      if (!variant.url) {
        throw new AdapterError(
          'web adapter needs variant.url (container variants are not supported yet)',
          { details: { variant: openOptions.variant } },
        );
      }
      let startUrl: string;
      try {
        startUrl = new URL(openOptions.startPath || '/', variant.url).href;
      } catch (error) {
        throw new AdapterError(`invalid variant url "${variant.url}"`, {
          cause: error,
          details: { variant: openOptions.variant },
        });
      }

      const browser = await launch();
      const headers = { ...variant.headers, ...openOptions.headers };
      const context = await browser.newContext({
        ...deviceContextOptions(openOptions.device, openOptions.viewport),
        ...(openOptions.locale ? { locale: openOptions.locale } : {}),
        ...(Object.keys(headers).length > 0 ? { extraHTTPHeaders: headers } : {}),
        ignoreHTTPSErrors,
        // Service workers can answer fetches before they reach the network layer, hiding analytics
        // calls from route interception.
        serviceWorkers: 'block',
      });
      const navigationTimeoutMs = openOptions.timeoutMs ?? defaultNavigationTimeoutMs;
      context.setDefaultTimeout(actionTimeoutMs);
      context.setDefaultNavigationTimeout(navigationTimeoutMs);

      try {
        return await WebSession.open({
          context,
          capture: openOptions.capture,
          startUrl,
          actionTimeoutMs,
          navigationTimeoutMs,
          settleTimeoutMs,
        });
      } catch (error) {
        await context.close().catch(() => undefined);
        if (error instanceof AgonError) throw error;
        throw new AdapterError(`failed to open ${startUrl}: ${shortErrorMessage(error)}`, {
          cause: error,
          details: { variant: openOptions.variant, url: startUrl },
        });
      }
    },

    async dispose(): Promise<void> {
      const pending = browserPromise;
      browserPromise = undefined;
      if (pending === undefined) return;
      const browser = await pending.catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    },
  };
}
