import { html } from 'hono/html';
import { EVENTS } from '../analytics.js';
import { isValidEmail, readForm, renderPage, safeRedirectTarget, track } from '../context.js';
import type { App, AppContext, Deps } from '../context.js';
import { errorSummary, statusBanner, textField } from '../html.js';
import type { Page } from '../html.js';
import { afterStepUrl } from '../onboarding.js';
import type { Store, User } from '../store.js';

const PLANS = ['starter', 'team', 'business'] as const;
type Plan = (typeof PLANS)[number];

interface SignupValues {
  email: string;
  company: string;
  plan: Plan;
}

export function registerAuthRoutes(app: App, deps: Deps): void {
  app.get('/signup', (c) => {
    if (c.get('user')) return c.redirect('/app', 303);
    const session = c.get('session');
    if (session && !session.signupStarted) {
      // The browser emits signup_started when the first field is focused; the server-side
      // log records the form being shown so tests can follow the funnel without a browser.
      session.signupStarted = true;
      track(c, deps, EVENTS.signupStarted, {}, { client: false });
    }
    return renderPage(
      c,
      signupPage({ email: '', company: '', plan: normalizePlan(c.req.query('plan')) }, {}),
    );
  });

  app.post('/signup', async (c) => {
    const form = await readForm(c);
    const values: SignupValues = {
      email: form['email'] ?? '',
      company: form['company'] ?? '',
      plan: normalizePlan(form['plan']),
    };
    const password = form['password'] ?? '';
    const errors = validateSignup(values.email, password, values.company, deps.store);
    if (Object.keys(errors).length > 0) return renderPage(c, signupPage(values, errors), 400);

    const variant = c.get('variant');
    const user = deps.store.createUser({
      email: values.email,
      password,
      company: values.company,
      variant,
      verified: false,
    });
    logIn(c, user);
    track(c, deps, EVENTS.signupCompleted, { plan: values.plan, method: 'email' });
    return c.redirect(afterStepUrl(user, variant, deps.store), 303);
  });

  app.get('/login', (c) => {
    if (c.get('user')) return c.redirect('/app', 303);
    const next = safeRedirectTarget(c.req.query('next'));
    const loggedOut = c.req.query('logged_out') === '1';
    return renderPage(c, loginPage({ email: '', next }, undefined, loggedOut));
  });

  app.post('/login', async (c) => {
    const form = await readForm(c);
    const email = form['email'] ?? '';
    const password = form['password'] ?? '';
    const next = safeRedirectTarget(form['next']);
    const user = deps.store.findUserByEmail(email);
    if (!user || !deps.store.verifyPassword(user, password)) {
      return renderPage(
        c,
        loginPage(
          { email, next },
          'We could not find an account with that email and password. Check both and try again.',
        ),
        400,
      );
    }
    logIn(c, user);
    return c.redirect(next, 303);
  });

  app.post('/logout', (c) => {
    const session = c.get('session');
    if (session) session.userId = undefined;
    c.set('user', undefined);
    return c.redirect('/login?logged_out=1', 303);
  });
}

function logIn(c: AppContext, user: User): void {
  const session = c.get('session');
  if (session) session.userId = user.id;
  c.set('user', user);
}

export function validateSignup(
  email: string,
  password: string,
  company: string,
  store: Store,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!email) errors['email'] = 'Enter your work email address.';
  else if (!isValidEmail(email))
    errors['email'] = 'Enter a valid email address, like you@company.com.';
  else if (store.findUserByEmail(email))
    errors['email'] = 'An account with this email already exists. Log in instead.';

  if (!password) errors['password'] = 'Choose a password.';
  else if (password.length < 8 || !/\d/.test(password) || !/[a-z]/i.test(password))
    errors['password'] = 'Use at least 8 characters, including a letter and a number.';

  if (!company) errors['company'] = 'Enter your company name.';
  else if (company.length > 80) errors['company'] = 'Company name must be 80 characters or fewer.';
  return errors;
}

function normalizePlan(value: string | undefined): Plan {
  return (PLANS as readonly string[]).includes(value ?? '') ? (value as Plan) : 'starter';
}

function signupPage(values: SignupValues, errors: Record<string, string>): Page {
  const planNote =
    values.plan === 'starter'
      ? 'Free for one project. No credit card required.'
      : `You are starting a 14-day free trial of the ${capitalize(values.plan)} plan. No credit card required.`;
  return {
    title: 'Create your account',
    body: html`<div class="container page narrow">
      <h1>Start your free Ledgerly account</h1>
      <p class="lede">${planNote}</p>
      ${errorSummary(errors)}
      <form class="form" method="post" action="/signup" novalidate>
        <input type="hidden" name="plan" value="${values.plan}" />
        ${textField({
          name: 'email',
          label: 'Work email',
          value: values.email,
          error: errors['email'],
          autocomplete: 'email',
          inputmode: 'email',
          placeholder: 'you@company.com',
        })}
        ${textField({
          name: 'password',
          label: 'Password',
          type: 'password',
          hint: 'At least 8 characters, including a letter and a number.',
          error: errors['password'],
          autocomplete: 'new-password',
        })}
        ${textField({
          name: 'company',
          label: 'Company name',
          value: values.company,
          error: errors['company'],
          autocomplete: 'organization',
          maxlength: 80,
        })}
        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-lg">Create account</button>
        </div>
      </form>
      <p class="form-footer">Already have an account? <a href="/login">Log in</a></p>
    </div>`,
    script: `(function () {
  var field = document.getElementById('email');
  if (!field || !window.posthog) return;
  field.addEventListener('focus', function () { posthog.capture('signup_started'); }, { once: true });
})();`,
  };
}

function loginPage(
  values: { email: string; next: string },
  error: string | undefined,
  loggedOut = false,
): Page {
  return {
    title: 'Log in',
    body: html`<div class="container page narrow">
      <h1>Log in to Ledgerly</h1>
      ${loggedOut ? statusBanner('You have been logged out.', 'info') : ''}
      ${error ? errorSummary({ email: error }) : ''}
      <form class="form" method="post" action="/login" novalidate>
        <input type="hidden" name="next" value="${values.next}" />
        ${textField({
          name: 'email',
          label: 'Email',
          value: values.email,
          autocomplete: 'email',
          inputmode: 'email',
          error: error,
        })}
        ${textField({
          name: 'password',
          label: 'Password',
          type: 'password',
          autocomplete: 'current-password',
        })}
        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-lg">Log in</button>
        </div>
      </form>
      <p class="form-footer">New to Ledgerly? <a href="/signup">Start free</a></p>
    </div>`,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
