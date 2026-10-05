/** Pure helpers behind `AdapterSession.act`; kept free of Playwright so they are unit-testable. */

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  capslock: 'CapsLock',
};

/**
 * Maps the loose key names a language model produces ("enter", "ctrl+a", "Esc") onto Playwright's
 * key names. Unknown multi-character tokens pass through so Playwright reports them.
 */
export function normalizeKey(key: string): string {
  return key
    .trim()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      if (part.length === 1) return part;
      const alias = KEY_ALIASES[part.toLowerCase()];
      if (alias !== undefined) return alias;
      const fn = /^f(\d{1,2})$/i.exec(part);
      if (fn) return `F${fn[1]}`;
      return part;
    })
    .join('+');
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BARE_HOST_RE = /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i;
const FILE_LIKE_RE = /^[\w-]+\.(?:html?|php|aspx?|jsp|js|css|json|xml|txt)(?:[/?#]|$)/i;

/**
 * Resolves a navigation target the way a user typing into the address bar would: absolute URLs
 * as-is, `//host/path` and bare hostnames as https, anything else relative to the current page.
 * Only http(s) is allowed. Throws a plain Error with a short message when the target is unusable.
 */
export function resolveNavigationUrl(target: string, currentUrl: string | undefined): URL {
  let candidate = target.trim();
  if (candidate === '') throw new Error('navigation target is empty');
  if (!SCHEME_RE.test(candidate)) {
    if (candidate.startsWith('//')) candidate = `https:${candidate}`;
    else if (
      !candidate.startsWith('/') &&
      BARE_HOST_RE.test(candidate) &&
      !FILE_LIKE_RE.test(candidate)
    ) {
      candidate = `https://${candidate}`;
    }
  }
  let url: URL;
  try {
    url = SCHEME_RE.test(candidate) ? new URL(candidate) : new URL(candidate, currentUrl);
  } catch {
    throw new Error(`cannot resolve navigation target "${target}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http(s) navigation is allowed, got ${url.protocol}`);
  }
  return url;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on', 'checked', 'check']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off', 'unchecked', 'uncheck', '']);

/** Interprets the text of a `fill` aimed at a checkbox or radio button. */
export function parseBooleanText(text: string): boolean | undefined {
  const word = text.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

/** First line of an error message, cut to `max` characters, for `ActResult.error`. */
export function shortErrorMessage(error: unknown, max = 200): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n').find((line) => line.trim() !== '') ?? 'unknown error';
  const trimmed = firstLine.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

const TARGET_CLOSED_RE =
  /target (?:page|context|browser).*closed|has been closed|target closed|browser closed|context closed|page closed|protocol error.*(?:closed|disconnected)/i;

/** True for Playwright errors that mean the page, context or browser is gone for good. */
export function isTargetClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return TARGET_CLOSED_RE.test(error.message);
}
