import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A tiny offline web app the adapter tests drive with real Chromium. */
export interface FixtureServer {
  baseUrl: string;
  /** Requests received per pathname (query string stripped). */
  hitCount(pathname: string): number;
  /** Raw bodies received by the fake analytics endpoints, in arrival order. */
  analyticsBodies: string[];
  close(): Promise<void>;
}

const ANALYTICS_PATHS = new Set(['/e/', '/capture/']);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NAV =
  '<header><nav><a href="/signup">Sign up</a> <a href="/pricing">Pricing</a> <a href="/errors">Errors</a></nav></header>';

const LANDING = page(
  'Agon Demo',
  `${NAV}
<main>
  <h1>Welcome to Agon Demo</h1>
  <p>The two-variant onboarding app used by the adapter tests.</p>
  <button id="spa" onclick="history.pushState({}, '', '/spa/step-two'); document.getElementById('stage').textContent = 'Step two';">Open step two</button>
  <p id="stage">Step one</p>
</main>
<footer>Agon fixtures</footer>`,
);

const PRICING = page(
  'Pricing',
  `${NAV}<main><h1>Pricing</h1><p>Free forever for simulated users.</p></main>`,
);

const SIGNUP = page(
  'Sign up',
  `${NAV}
<main>
  <h1>Create your account</h1>
  <form id="signup" method="post" action="/welcome" novalidate>
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" placeholder="you@example.com">
    <label for="password">Password</label>
    <input id="password" name="password" type="password">
    <button type="submit">Create account</button>
    <p id="error" role="alert" hidden></p>
  </form>
</main>
<script>
  document.getElementById('signup').addEventListener('submit', (event) => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const error = document.getElementById('error');
    if (!email.includes('@')) {
      event.preventDefault();
      error.hidden = false;
      error.textContent = 'Enter a valid email address';
      return;
    }
    if (password.length < 8) {
      event.preventDefault();
      error.hidden = false;
      error.textContent = 'Password must be at least 8 characters';
    }
  });
</script>`,
);

const WELCOME = page(
  'Welcome',
  '<main><h1>Welcome aboard</h1><p>Your account is ready.</p></main>',
);

const ERRORS = page(
  'Errors',
  `<main><h1>Errors</h1><p>This page misbehaves on purpose.</p></main>
<script>
  console.error('boom from console');
  fetch('/missing').catch(() => {});
  setTimeout(() => { throw new Error('kaboom uncaught'); }, 0);
</script>`,
);

const ANALYTICS = page(
  'Analytics',
  `<main><h1>Analytics</h1><p id="status">sending analytics</p></main>
<script>
  const first = fetch('/e/?ip=1&_=1700000000', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ event: 'signup_viewed', properties: { $distinct_id: 'user-1', plan: 'pro' } }),
  });
  const payload = btoa(JSON.stringify([
    { event: 'cta_clicked', properties: { distinct_id: 'user-1', cta: 'hero' } },
    { event: '$pageview', properties: { $current_url: location.href } },
  ]));
  const second = fetch('/capture/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(payload) + '&compression=base64',
  });
  Promise.allSettled([first, second]).then(() => {
    document.getElementById('status').textContent = 'analytics sent';
  });
</script>`,
);

const BEACON = page(
  'Beacon',
  `<main><h1>Beacon</h1><p id="status">sending beacon</p><a href="/welcome">Leave</a></main>
<script>
  navigator.sendBeacon('/e/?beacon=1', JSON.stringify([{ event: 'beacon_event', properties: { distinct_id: 'user-9' } }]));
  document.getElementById('status').textContent = 'beacon sent';
  addEventListener('pagehide', () => {
    fetch('/capture/', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(btoa(JSON.stringify([{ event: 'unload_event', properties: {} }]))),
    });
  });
</script>`,
);

const OFFSCREEN = page(
  'Offscreen',
  `<style>.skip-link{position:absolute;left:-999px;top:auto}.skip-link:focus{left:8px}</style>
<a class="skip-link" href="#main">Skip to main content</a>
<main id="main"><h1>Offscreen</h1><button id="real">Real button</button></main>`,
);

const MANY = page(
  'Many buttons',
  `<main><h1>Many buttons</h1>
${Array.from({ length: 70 }, (_, i) => `<button>Button ${i + 1}</button>`).join('\n')}
${Array.from(
  { length: 30 },
  (_, i) =>
    `<p>Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog while the simulated user keeps reading far beyond the fold of this fixture page.</p>`,
).join('\n')}
</main>`,
);

const CONTROLS = page(
  'Controls',
  `<main>
  <h1>Controls</h1>
  <label for="email">Email address</label><input id="email" type="email" value="">
  <input type="text" aria-label="Search the docs" value="playwright">
  <input type="text" placeholder="Promo code">
  <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label>
  <label><input type="checkbox" id="terms"> I accept the terms</label>
  <input type="radio" name="size" value="s" id="size-s" checked><label for="size-s">Small</label>
  <input type="radio" name="size" value="l" id="size-l"><label for="size-l">Large</label>
  <textarea aria-label="Notes">hello</textarea>
  <div contenteditable="true" aria-label="Editor">Draft</div>
  <div role="button" tabindex="0">Fancy button</div>
  <div tabindex="0" id="focusable">Focusable card</div>
  <span onclick="void 0">Clickable span</span>
  <button disabled>Disabled action</button>
  <a href="/logo"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="24" height="24" alt="Company logo"></a>
  <button title="Settings"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"></circle></svg></button>
  <div role="switch" aria-checked="true" tabindex="0">Dark mode</div>
  <input type="hidden" name="csrf" value="x">
  <a href="/hidden" style="display:none">Hidden link</a>
  <a href="/invisible" style="visibility:hidden">Invisible link</a>
  <div aria-hidden="true"><button>Decorative</button></div>
</main>`,
);

const VIEWPORT = page(
  'Viewport',
  `<main><p id="w"></p></main><script>document.getElementById('w').textContent = 'innerWidth=' + window.innerWidth;</script>`,
);

const LOCALE = page(
  'Locale',
  `<main><p id="l"></p></main><script>document.getElementById('l').textContent = 'language=' + navigator.language;</script>`,
);

const PAGES: Readonly<Record<string, string>> = {
  '/': LANDING,
  '/pricing': PRICING,
  '/signup': SIGNUP,
  '/welcome': WELCOME,
  '/errors': ERRORS,
  '/analytics': ANALYTICS,
  '/beacon': BEACON,
  '/offscreen': OFFSCREEN,
  '/many': MANY,
  '/controls': CONTROLS,
  '/viewport': VIEWPORT,
  '/locale': LOCALE,
  '/spa/step-two': LANDING,
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hits = new Map<string, number>();
  const analyticsBodies: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    void readBody(req).then((body) => {
      if (ANALYTICS_PATHS.has(pathname)) {
        analyticsBodies.push(body);
        send(res, 200, 'application/json', '{"status":1}');
        return;
      }
      if (pathname === '/headers') {
        const test = String(req.headers['x-agon-test'] ?? '');
        const variant = String(req.headers['x-variant-header'] ?? '');
        send(
          res,
          200,
          'text/html; charset=utf-8',
          page(
            'Headers',
            `<main><p>x-agon-test=${escapeHtml(test)}</p><p>x-variant-header=${escapeHtml(variant)}</p></main>`,
          ),
        );
        return;
      }
      const html = PAGES[pathname];
      if (html !== undefined) {
        send(res, 200, 'text/html; charset=utf-8', html);
        return;
      }
      send(res, 404, 'text/plain', 'not found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    analyticsBodies,
    hitCount: (pathname) => hits.get(pathname) ?? 0,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
