import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { ClientEvent, User } from './store.js';
import type { Variant } from './types.js';

/** A fragment produced by the `html` tagged template. Values interpolated into it are escaped. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface LayoutContext {
  variant: Variant;
  user: User | undefined;
  path: string;
  /** Product events queued server-side; the analytics shim emits them as soon as this page loads. */
  clientEvents: ClientEvent[];
}

export interface Page {
  title: string;
  body: Html;
  /** Inline JavaScript appended after the analytics bootstrap. Must already be safe to embed. */
  script?: string;
}

// "<" (so "</script>" can never appear) and the two Unicode line terminators JSON leaves raw.
const SCRIPT_UNSAFE = new RegExp('[<\\u2028\\u2029]', 'g');

/** JSON that is safe to embed inside a <script> element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    SCRIPT_UNSAFE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function layout(ctx: LayoutContext, page: Page): Html {
  const bootstrap = [
    'if (window.posthog) {',
    `  posthog.register(${jsonForScript({ variant: ctx.variant })});`,
    ctx.user
      ? `  posthog.identify(${jsonForScript(ctx.user.id)}, ${jsonForScript({
          email: ctx.user.email,
          company: ctx.user.company,
        })});`
      : '',
    ...ctx.clientEvents.map(
      (e) => `  posthog.capture(${jsonForScript(e.event)}, ${jsonForScript(e.properties)});`,
    ),
    '}',
    page.script ?? '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return html`<!doctype html>
    <html lang="en" data-variant="${ctx.variant}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${page.title} · Ledgerly</title>
        <meta name="ledgerly-variant" content="${ctx.variant}" />
        <link rel="icon" href="${raw(FAVICON)}" />
        <style>
          ${raw(CSS)}
        </style>
        <script src="/static/analytics.js"></script>
      </head>
      <body>
        <a class="skip-link" href="#main">Skip to main content</a>
        ${header(ctx)}
        <main id="main" tabindex="-1">${page.body}</main>
        ${footer()}
        <script>
          ${raw(bootstrap)};
        </script>
      </body>
    </html>`;
}

function header(ctx: LayoutContext): Html {
  const link = (href: string, label: string): Html =>
    html`<a href="${href}" ${ctx.path === href ? raw(' aria-current="page"') : ''}>${label}</a>`;
  const items = ctx.user
    ? html`<li>${link('/app', 'Dashboard')}</li>
        <li>${link('/projects/new', 'New project')}</li>
        <li>${link('/app/settings', 'Settings')}</li>
        <li>
          <form method="post" action="/logout">
            <button type="submit" class="btn btn-ghost">Log out</button>
          </form>
        </li>`
    : html`<li>${link('/#features', 'Product')}</li>
        <li>${link('/pricing', 'Pricing')}</li>
        <li>${link('/docs', 'Docs')}</li>
        <li>${link('/login', 'Log in')}</li>
        <li><a class="btn btn-primary" href="/signup">Start free</a></li>`;
  return html`<header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">L</span>Ledgerly</a>
      <nav aria-label="Main">
        <ul class="nav-list">
          ${items}
        </ul>
      </nav>
    </div>
  </header>`;
}

function footer(): Html {
  return html`<footer class="site-footer">
    <div class="container footer-inner">
      <p>© 2026 Ledgerly, Inc. A fictional product that serves as the Agon demo target.</p>
      <ul>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/docs">Docs</a></li>
        <li><a href="/login">Log in</a></li>
      </ul>
    </div>
  </footer>`;
}

// ---------------------------------------------------------------------------
// Form components. Every control has a label; errors are announced and linked.
// ---------------------------------------------------------------------------

export interface FieldOptions {
  name: string;
  label: string;
  type?: 'text' | 'password';
  value?: string;
  error?: string;
  hint?: string;
  autocomplete?: string;
  inputmode?: string;
  placeholder?: string;
  maxlength?: number;
  required?: boolean;
}

export function textField(o: FieldOptions): Html {
  const hintId = `${o.name}-hint`;
  const errorId = `${o.name}-error`;
  const describedBy = [o.hint ? hintId : '', o.error ? errorId : ''].filter(Boolean).join(' ');
  return html`<div class="field${o.error ? ' field-error' : ''}">
    <label for="${o.name}"
      >${o.label}${
        o.required === false ? html` <span class="optional">(optional)</span>` : ''
      }</label
    >
    ${o.hint ? html`<p class="hint" id="${hintId}">${o.hint}</p>` : ''}
    ${o.error ? html`<p class="error-text" id="${errorId}"><span class="visually-hidden">Error:</span> ${o.error}</p>` : ''}
    <input
      id="${o.name}"
      name="${o.name}"
      type="${o.type ?? 'text'}"
      value="${o.value ?? ''}"
      ${
        describedBy ? html` aria-describedby="${describedBy}"` : ''
      }${o.error ? raw(' aria-invalid="true"') : ''}${
        o.required === false ? '' : raw(' aria-required="true"')
      }${o.autocomplete ? html` autocomplete="${o.autocomplete}"` : ''}${
        o.inputmode ? html` inputmode="${o.inputmode}"` : ''
      }${o.placeholder ? html` placeholder="${o.placeholder}"` : ''}${
        o.maxlength ? html` maxlength="${o.maxlength}"` : ''
      }
    />
  </div>`;
}

export interface Choice {
  value: string;
  label: string;
}

export interface SelectOptions {
  name: string;
  label: string;
  options: Choice[];
  value?: string;
  error?: string;
  hint?: string;
  placeholder?: string;
}

export function selectField(o: SelectOptions): Html {
  const hintId = `${o.name}-hint`;
  const errorId = `${o.name}-error`;
  const describedBy = [o.hint ? hintId : '', o.error ? errorId : ''].filter(Boolean).join(' ');
  return html`<div class="field${o.error ? ' field-error' : ''}">
    <label for="${o.name}">${o.label}</label>
    ${o.hint ? html`<p class="hint" id="${hintId}">${o.hint}</p>` : ''}
    ${o.error ? html`<p class="error-text" id="${errorId}"><span class="visually-hidden">Error:</span> ${o.error}</p>` : ''}
    <select
      id="${o.name}"
      name="${o.name}"
      ${describedBy ? html` aria-describedby="${describedBy}"` : ''}${
        o.error ? raw(' aria-invalid="true"') : ''
      }
      aria-required="true"
    >
      ${o.placeholder ? html`<option value="" ${o.value ? '' : raw(' selected')}>${o.placeholder}</option>` : ''}
      ${o.options.map(
        (opt) =>
          html`<option value="${opt.value}" ${opt.value === o.value ? raw(' selected') : ''}>
            ${opt.label}
          </option>`,
      )}
    </select>
  </div>`;
}

export interface RadioGroupOptions {
  name: string;
  legend: string;
  options: Choice[];
  value?: string;
  error?: string;
  hint?: string;
}

export function radioGroup(o: RadioGroupOptions): Html {
  const hintId = `${o.name}-hint`;
  const errorId = `${o.name}-error`;
  const describedBy = [o.hint ? hintId : '', o.error ? errorId : ''].filter(Boolean).join(' ');
  return html`<fieldset
    id="${o.name}"
    ${describedBy ? html` aria-describedby="${describedBy}"` : ''}${
      o.error ? raw(' aria-invalid="true"') : ''
    }
  >
    <legend>${o.legend}</legend>
    ${o.hint ? html`<p class="hint" id="${hintId}">${o.hint}</p>` : ''}
    ${o.error ? html`<p class="error-text" id="${errorId}"><span class="visually-hidden">Error:</span> ${o.error}</p>` : ''}
    ${o.options.map(
      (opt) =>
        html`<div class="radio">
          <input
            type="radio"
            id="${o.name}-${opt.value}"
            name="${o.name}"
            value="${opt.value}"
            ${opt.value === o.value ? raw(' checked') : ''}
          />
          <label for="${o.name}-${opt.value}">${opt.label}</label>
        </div>`,
    )}
  </fieldset>`;
}

export function checkboxField(o: { name: string; label: string; error?: string }): Html {
  const errorId = `${o.name}-error`;
  return html`<div class="field${o.error ? ' field-error' : ''}">
    ${o.error ? html`<p class="error-text" id="${errorId}"><span class="visually-hidden">Error:</span> ${o.error}</p>` : ''}
    <div class="checkbox">
      <input
        type="checkbox"
        id="${o.name}"
        name="${o.name}"
        value="yes"
        ${o.error ? html` aria-describedby="${errorId}" aria-invalid="true"` : ''}
      />
      <label for="${o.name}">${o.label}</label>
    </div>
  </div>`;
}

/** Summary of validation errors, announced immediately and linking to each field. */
export function errorSummary(errors: Record<string, string>): Html {
  const entries = Object.entries(errors);
  if (entries.length === 0) return html``;
  return html`<div class="error-summary" role="alert" tabindex="-1">
    <h2 class="error-summary-title">There is a problem</h2>
    <ul>
      ${entries.map(([field, message]) => html`<li><a href="#${field}">${message}</a></li>`)}
    </ul>
  </div>`;
}

export function statusBanner(message: Html | string, kind: 'success' | 'info' = 'success'): Html {
  return html`<div class="banner banner-${kind}" role="status">${message}</div>`;
}

export interface ProgressItem {
  label: string;
  state: 'done' | 'current' | 'todo';
}

export function progressSteps(items: ProgressItem[]): Html {
  return html`<nav aria-label="Onboarding progress">
    <ol class="progress">
      ${items.map(
        (item, i) =>
          html`<li
            class="progress-${item.state}"
            ${item.state === 'current' ? raw(' aria-current="step"') : ''}
          >
            <span class="progress-num" aria-hidden="true">${i + 1}</span
            ><span
              >${item.label}${
                item.state === 'done' ? html`<span class="visually-hidden"> (completed)</span>` : ''
              }</span
            >
          </li>`,
      )}
    </ol>
  </nav>`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f6f5f'/%3E%3Cpath d='M10 7h4.5v13.5H23V25H10z' fill='white'/%3E%3C/svg%3E";

const CSS = `
:root{--ink:#1a1f26;--muted:#5b6672;--brand:#1f6f5f;--brand-dark:#174f44;--brand-soft:#e6f2ee;--border:#d8dee5;--surface:#f5f7f9;--bg:#fff;--danger:#b42318;--danger-soft:#fdecea;--success:#0e7a4e;--success-soft:#e3f5ec;--focus:#ffbf47;--radius:10px;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.1)}
*,*::before,*::after{box-sizing:border-box}
html{font-size:16px;-webkit-text-size-adjust:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.5}
a{color:var(--brand-dark)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip-link{position:absolute;left:-999px;top:8px;background:var(--ink);color:#fff;padding:.5rem .75rem;border-radius:6px;z-index:100}
.skip-link:focus{left:8px}
.container{max-width:1040px;margin:0 auto;padding:0 1.25rem}
.site-header{border-bottom:1px solid var(--border);background:var(--bg)}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:64px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;font-size:1.2rem;color:var(--ink);text-decoration:none}
.brand-mark{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--brand);color:#fff;font-weight:800}
.nav-list{display:flex;align-items:center;gap:1.25rem;list-style:none;margin:0;padding:0;flex-wrap:wrap}
.nav-list a{text-decoration:none;color:var(--ink);font-weight:500}
.nav-list a[aria-current=page]{color:var(--brand-dark);text-decoration:underline;text-underline-offset:6px}
.nav-list form{margin:0}
.btn{display:inline-block;padding:.6rem 1rem;border-radius:8px;border:1px solid transparent;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;line-height:1.2}
.btn-primary{background:var(--brand);color:#fff!important;border-color:var(--brand)}
.btn-primary:hover{background:var(--brand-dark)}
.btn-secondary{background:#fff;color:var(--brand-dark)!important;border-color:var(--brand)}
.btn-secondary:hover{background:var(--brand-soft)}
.btn-ghost{background:transparent;color:var(--ink);border-color:var(--border)}
.btn-danger{background:var(--danger);color:#fff;border-color:var(--danger)}
.btn-lg{padding:.85rem 1.4rem;font-size:1.05rem}
.link-button{background:none;border:0;padding:0;font:inherit;color:var(--brand-dark);text-decoration:underline;cursor:pointer}
.link-subtle{font-size:.8rem;color:#8b949e}
.hero{padding:4.5rem 0 3.5rem;background:linear-gradient(180deg,var(--brand-soft),#fff)}
.hero h1{font-size:clamp(2rem,4.5vw,3.25rem);line-height:1.1;margin:0 0 1rem;max-width:18ch}
.lede{font-size:1.15rem;color:var(--muted);max-width:60ch;margin:0 0 1.5rem}
.cta-row{display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:.75rem}
.fine-print{color:var(--muted);font-size:.9rem;margin:0}
.section{padding:3.5rem 0}
.section h2{font-size:1.75rem;margin:0 0 1.5rem}
.section-alt{background:var(--surface)}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem}
.card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;box-shadow:var(--shadow)}
.card h3{margin:0 0 .5rem;font-size:1.1rem}
.card p{margin:0;color:var(--muted)}
.quote{margin:0;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem}
.quote blockquote{margin:0 0 .75rem;font-style:italic}
.quote figcaption{color:var(--muted);font-size:.9rem}
.pricing-teaser p{font-size:1.1rem;margin:0 0 1rem}
.cta-section{text-align:center}
.cta-section p{color:var(--muted);margin:0 0 1.25rem}
.page{padding:2.5rem 0 4rem}
.page h1{font-size:2rem;margin:0 0 .5rem}
.narrow{max-width:560px}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.25rem;margin:2rem 0 3rem;align-items:start}
.tier{position:relative;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:1.75rem;box-shadow:var(--shadow)}
.tier-featured{border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-soft),var(--shadow)}
.tier h2{margin:0 0 .25rem;font-size:1.25rem}
.badge{position:absolute;top:-.8rem;left:1.75rem;margin:0;background:var(--brand);color:#fff;font-size:.75rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
.price{margin:0 0 1rem}
.amount{font-size:2.25rem;font-weight:700}
.per{color:var(--muted)}
.tier ul{padding-left:1.1rem;margin:0 0 1.5rem;color:var(--muted)}
.tier li{margin:.35rem 0}
.faq details{border-top:1px solid var(--border);padding:.9rem 0}
.faq details:last-child{border-bottom:1px solid var(--border)}
.faq summary{font-weight:600;cursor:pointer}
.faq p{color:var(--muted);margin:.5rem 0 0}
.docs section{margin-top:2rem}
.docs nav ul{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;list-style:none;padding:0;margin:0 0 1rem}
form.form{margin-top:1.5rem}
.field{margin-bottom:1.25rem}
label,legend{display:block;font-weight:600;margin-bottom:.35rem}
.optional{font-weight:400;color:var(--muted)}
.hint{margin:0 0 .4rem;color:var(--muted);font-size:.9rem}
input[type=text],input[type=password],select{width:100%;padding:.65rem .75rem;border:1px solid #8a949e;border-radius:8px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus{border-color:var(--brand)}
.field-error input,.field-error select,[aria-invalid=true]{border-color:var(--danger)!important;border-width:2px}
.error-text{color:var(--danger);font-weight:600;margin:0 0 .4rem;font-size:.95rem}
.error-summary{border:3px solid var(--danger);border-radius:var(--radius);padding:1rem 1.25rem;margin:1.5rem 0}
.error-summary-title{margin:0 0 .5rem;font-size:1.1rem;color:var(--danger)}
.error-summary ul{margin:0;padding-left:1.2rem}
.error-summary a{color:var(--danger);font-weight:600}
fieldset{border:0;padding:0;margin:0 0 1.25rem;min-width:0}
.radio{display:flex;align-items:center;gap:.6rem;padding:.6rem .75rem;border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem}
.radio label{margin:0;font-weight:500}
.checkbox{display:flex;gap:.6rem;align-items:flex-start}
.checkbox label{font-weight:500;margin:0}
.form-actions{display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap;margin-top:1.5rem}
.form-actions form{margin:0}
.form-footer{margin-top:1.5rem;color:var(--muted)}
.banner{padding:.9rem 1.1rem;border-radius:var(--radius);margin:1rem 0 1.5rem;border:1px solid}
.banner-success{background:var(--success-soft);border-color:var(--success);color:#0b5c3b}
.banner-info{background:var(--brand-soft);border-color:var(--brand);color:var(--brand-dark)}
.step-indicator{color:var(--muted);font-size:.85rem;margin:0 0 .5rem;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.progress{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;list-style:none;padding:0;margin:0 0 2rem;font-size:.9rem;color:var(--muted)}
.progress li{display:flex;align-items:center;gap:.4rem}
.progress-num{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1px solid var(--border);font-size:.75rem}
.progress-done .progress-num{background:var(--success);border-color:var(--success);color:#fff}
.progress-current{color:var(--ink);font-weight:600}
.progress-current .progress-num{border-color:var(--brand);color:var(--brand-dark)}
.dev-hint{margin-top:5rem;font-size:.72rem;color:#c3c9d0;border-top:1px dashed #e8ebee;padding-top:.5rem}
.dev-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:inherit}
.security-note{color:var(--muted);font-size:.9rem;margin:1rem 0 0}
.setup-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin:0 0 2.5rem}
.setup-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.25rem}
.setup-card h3{margin:0 0 .35rem;font-size:1rem}
.setup-card p{margin:0 0 .75rem;color:var(--muted);font-size:.95rem}
.section-head{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin:2rem 0 1rem}
.section-head h2{margin:0;font-size:1.4rem}
.card-list{list-style:none;padding:0;margin:0;display:grid;gap:.75rem}
.project{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem}
.project h3{margin:0;font-size:1.05rem}
.meta{color:var(--muted);font-size:.9rem;margin:.15rem 0 0}
.empty{border:1px dashed var(--border);border-radius:var(--radius);padding:2rem;text-align:center;color:var(--muted)}
dl.details{display:grid;grid-template-columns:max-content 1fr;gap:.5rem 1.5rem;margin:1rem 0}
dl.details dt{font-weight:600}
dl.details dd{margin:0}
.settings-section{border-top:1px solid var(--border);padding:1.75rem 0}
.settings-section h2{margin:0 0 .5rem;font-size:1.25rem}
.danger-zone{border:1px solid var(--danger);border-radius:var(--radius);padding:1.25rem;background:var(--danger-soft)}
.site-footer{border-top:1px solid var(--border);padding:2rem 0;color:var(--muted);font-size:.9rem;margin-top:3rem}
.footer-inner{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.site-footer p{margin:0}
.site-footer ul{display:flex;gap:1.25rem;list-style:none;padding:0;margin:0}
.site-footer a{color:var(--muted)}
@media (max-width:640px){.hero{padding:3rem 0 2.5rem}.section{padding:2.5rem 0}.header-inner{justify-content:center}}
`;
