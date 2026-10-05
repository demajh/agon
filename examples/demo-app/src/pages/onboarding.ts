import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { EVENTS } from '../analytics.js';
import { currentUser, isValidEmail, readForm, renderPage, track } from '../context.js';
import type { App, AppContext, Deps } from '../context.js';
import {
  errorSummary,
  progressSteps,
  radioGroup,
  selectField,
  statusBanner,
  textField,
} from '../html.js';
import type { Choice, Html, ProgressItem } from '../html.js';
import { ONBOARDING_STEPS, STEP_LABELS, afterStepUrl, isStepComplete } from '../onboarding.js';
import type { OnboardingStep } from '../onboarding.js';
import { DEV_VERIFICATION_CODE } from '../store.js';
import type { User } from '../store.js';
import type { Variant } from '../types.js';

export const ROLE_OPTIONS: Choice[] = [
  { value: 'owner', label: 'Owner or founder' },
  { value: 'finance', label: 'Finance lead or controller' },
  { value: 'bookkeeper', label: 'Accountant or bookkeeper' },
  { value: 'operations', label: 'Operations' },
  { value: 'other', label: 'Other' },
];

export const TEAM_SIZE_OPTIONS: Choice[] = [
  { value: '1', label: 'Just me' },
  { value: '2-10', label: '2 to 10 people' },
  { value: '11-50', label: '11 to 50 people' },
  { value: '51+', label: 'More than 50 people' },
];

export const BANK_OPTIONS: Choice[] = [
  { value: 'first-harbor', label: 'First Harbor Bank' },
  { value: 'meridian', label: 'Meridian Credit Union' },
  { value: 'northwind', label: 'Northwind Business Banking' },
  { value: 'other', label: 'Another bank' },
];

export const CURRENCY_OPTIONS: Choice[] = [
  { value: 'USD', label: 'USD · US dollar' },
  { value: 'EUR', label: 'EUR · Euro' },
  { value: 'GBP', label: 'GBP · British pound' },
  { value: 'CAD', label: 'CAD · Canadian dollar' },
  { value: 'AUD', label: 'AUD · Australian dollar' },
];

const DEFAULT_CURRENCY = 'USD';
const MAX_PROJECT_NAME = 60;
const INVITE_FIELDS = ['invite_1', 'invite_2', 'invite_3'] as const;

export function defaultProjectName(user: User): string {
  return `${user.company} Books`;
}

export function registerOnboardingRoutes(app: App, deps: Deps): void {
  // --- verify ------------------------------------------------------------------
  app.get('/onboarding/verify', (c) =>
    stepPage(c, deps, 'verify', 'Verify your email', verifyContent(currentUser(c), '', {}, false)),
  );

  app.post('/onboarding/verify/resend', (c) =>
    stepPage(c, deps, 'verify', 'Verify your email', verifyContent(currentUser(c), '', {}, true)),
  );

  app.post('/onboarding/verify', async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const code = (form['code'] ?? '').replace(/\s+/g, '');
    const errors: Record<string, string> = {};
    if (!code) errors['code'] = 'Enter the 6-digit code from your email.';
    else if (!/^\d{6}$/.test(code)) errors['code'] = 'The code is exactly 6 digits.';
    else if (code !== DEV_VERIFICATION_CODE)
      errors['code'] = 'That code did not match. Check the digits and try again.';
    if (Object.keys(errors).length > 0) {
      return stepPage(
        c,
        deps,
        'verify',
        'Verify your email',
        verifyContent(user, code, errors, false),
        400,
      );
    }
    user.verified = true;
    track(c, deps, EVENTS.onboardingStepCompleted, { step: 'verify' });
    return c.redirect(afterStepUrl(user, c.get('variant'), deps.store), 303);
  });

  // --- profile -----------------------------------------------------------------
  app.get('/onboarding/profile', (c) => {
    const user = currentUser(c);
    const values = { role: user.profile?.role ?? '', team_size: user.profile?.teamSize ?? '' };
    return stepPage(c, deps, 'profile', 'Tell us about your team', profileContent(values, {}));
  });

  app.post('/onboarding/profile', async (c) => {
    const user = currentUser(c);
    const { values, errors } = validateProfile(await readForm(c));
    if (Object.keys(errors).length > 0) {
      return stepPage(
        c,
        deps,
        'profile',
        'Tell us about your team',
        profileContent(values, errors),
        400,
      );
    }
    user.profile = { role: values.role, teamSize: values.team_size };
    track(c, deps, EVENTS.onboardingStepCompleted, {
      step: 'profile',
      role: values.role,
      team_size: values.team_size,
    });
    return c.redirect(afterStepUrl(user, c.get('variant'), deps.store), 303);
  });

  // --- connect-bank ------------------------------------------------------------
  app.get('/onboarding/connect-bank', (c) =>
    stepPage(c, deps, 'connect-bank', 'Connect your bank', bankContent('', {})),
  );

  app.post('/onboarding/connect-bank', async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const bank = form['bank'] ?? '';
    const choice = BANK_OPTIONS.find((b) => b.value === bank);
    if (!choice) {
      const errors = { bank: 'Choose a bank to connect, or skip this step for now.' };
      return stepPage(c, deps, 'connect-bank', 'Connect your bank', bankContent(bank, errors), 400);
    }
    user.bank = { bank: choice.label, connectedAt: deps.options.now().toISOString() };
    user.bankSkipped = false;
    track(c, deps, EVENTS.onboardingStepCompleted, { step: 'connect-bank', bank: choice.value });
    return c.redirect(afterStepUrl(user, c.get('variant'), deps.store), 303);
  });

  app.post('/onboarding/connect-bank/skip', (c) => {
    const user = currentUser(c);
    user.bankSkipped = true;
    track(c, deps, EVENTS.onboardingSkipped, { step: 'connect-bank' });
    return c.redirect(afterStepUrl(user, c.get('variant'), deps.store), 303);
  });

  // --- invite ------------------------------------------------------------------
  app.get('/onboarding/invite', (c) =>
    stepPage(c, deps, 'invite', 'Invite your team', inviteContent(currentUser(c), {}, {})),
  );

  app.post('/onboarding/invite', async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const errors: Record<string, string> = {};
    const values: Record<string, string> = {};
    const emails: string[] = [];
    INVITE_FIELDS.forEach((field, i) => {
      const value = form[field] ?? '';
      values[field] = value;
      if (!value) return;
      if (!isValidEmail(value)) {
        errors[field] = `Enter a valid email address for teammate ${i + 1}, or leave it blank.`;
      } else {
        emails.push(value.toLowerCase());
      }
    });
    if (Object.keys(errors).length > 0) {
      return stepPage(
        c,
        deps,
        'invite',
        'Invite your team',
        inviteContent(user, values, errors),
        400,
      );
    }
    user.invites = [...new Set([...user.invites, ...emails])];
    user.inviteStepDone = true;
    track(c, deps, EVENTS.onboardingStepCompleted, { step: 'invite', invites: emails.length });
    return c.redirect(afterStepUrl(user, c.get('variant'), deps.store), 303);
  });

  // --- project -----------------------------------------------------------------
  app.get('/onboarding/project', (c) => {
    const user = currentUser(c);
    const variant = c.get('variant');
    const values =
      variant === 'treatment'
        ? { name: defaultProjectName(user), currency: DEFAULT_CURRENCY }
        : { name: '', currency: '' };
    return stepPage(
      c,
      deps,
      'project',
      projectTitle(variant),
      projectContent(variant, user, values, {}),
    );
  });

  app.post('/onboarding/project', async (c) => {
    const user = currentUser(c);
    const variant = c.get('variant');
    const form = await readForm(c);
    const values = { name: form['name'] ?? '', currency: form['currency'] ?? '' };
    if (variant === 'treatment') {
      // Sensible defaults: the treatment never blocks on an empty field.
      if (!values.name) values.name = defaultProjectName(user);
      if (!CURRENCY_OPTIONS.some((o) => o.value === values.currency))
        values.currency = DEFAULT_CURRENCY;
    }
    const errors = validateProject(values);
    if (Object.keys(errors).length > 0) {
      return stepPage(
        c,
        deps,
        'project',
        projectTitle(variant),
        projectContent(variant, user, values, errors),
        400,
      );
    }
    const project = deps.store.createProject({
      userId: user.id,
      name: values.name,
      currency: values.currency,
      variant,
    });
    track(c, deps, EVENTS.onboardingStepCompleted, { step: 'project' });
    track(c, deps, EVENTS.projectCreated, {
      variant,
      project_id: project.id,
      currency: project.currency,
      source: 'onboarding',
    });
    return c.redirect('/app?welcome=1', 303);
  });
}

// ---------------------------------------------------------------------------
// Shared validation (settings reuses it)
// ---------------------------------------------------------------------------

export interface ProfileValues {
  role: string;
  team_size: string;
}

export function validateProfile(form: Record<string, string>): {
  values: ProfileValues;
  errors: Record<string, string>;
} {
  const values: ProfileValues = { role: form['role'] ?? '', team_size: form['team_size'] ?? '' };
  const errors: Record<string, string> = {};
  if (!ROLE_OPTIONS.some((o) => o.value === values.role))
    errors['role'] = 'Choose the option that best describes your role.';
  if (!TEAM_SIZE_OPTIONS.some((o) => o.value === values.team_size))
    errors['team_size'] = 'Choose your team size.';
  return { values, errors };
}

export function validateProject(values: {
  name: string;
  currency: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.name) errors['name'] = 'Name your project.';
  else if (values.name.length > MAX_PROJECT_NAME)
    errors['name'] = `Project name must be ${MAX_PROJECT_NAME} characters or fewer.`;
  if (!CURRENCY_OPTIONS.some((o) => o.value === values.currency))
    errors['currency'] = 'Choose a base currency.';
  return errors;
}

export function profileFields(values: ProfileValues, errors: Record<string, string>): Html {
  return html`${selectField({
    name: 'role',
    label: 'Your role',
    options: ROLE_OPTIONS,
    value: values.role,
    error: errors['role'],
    placeholder: 'Choose your role',
  })}
  ${selectField({
    name: 'team_size',
    label: 'Team size',
    options: TEAM_SIZE_OPTIONS,
    value: values.team_size,
    error: errors['team_size'],
    hint: 'Everyone who will touch the books, including outside accountants.',
    placeholder: 'Choose a team size',
  })}`;
}

export function projectFields(
  values: { name: string; currency: string },
  errors: Record<string, string>,
): Html {
  return html`${textField({
    name: 'name',
    label: 'Project name',
    value: values.name,
    error: errors['name'],
    hint: 'Usually the legal name of the company whose books these are.',
    maxlength: MAX_PROJECT_NAME,
  })}
  ${selectField({
    name: 'currency',
    label: 'Base currency',
    options: CURRENCY_OPTIONS,
    value: values.currency,
    error: errors['currency'],
    placeholder: 'Choose a currency',
  })}`;
}

// ---------------------------------------------------------------------------
// Page shells and content
// ---------------------------------------------------------------------------

function stepPage(
  c: AppContext,
  deps: Deps,
  step: OnboardingStep,
  title: string,
  content: Html,
  status: ContentfulStatusCode = 200,
): Response | Promise<Response> {
  const user = currentUser(c);
  const variant = c.get('variant');
  let head: Html;
  if (variant === 'control') {
    const items: ProgressItem[] = [
      { label: 'Create account', state: 'done' },
      ...ONBOARDING_STEPS.map((s): ProgressItem => ({
        label: STEP_LABELS[s],
        state: s === step ? 'current' : isStepComplete(s, user, deps.store) ? 'done' : 'todo',
      })),
    ];
    const position = ONBOARDING_STEPS.indexOf(step) + 2;
    head = html`<p class="step-indicator">Step ${position} of ${items.length}</p>
      ${progressSteps(items)}`;
  } else if (deps.store.projectsForUser(user.id).length > 0) {
    head = html`<p class="step-indicator"><a href="/app">Dashboard</a> › ${STEP_LABELS[step]}</p>`;
  } else {
    head = html`<p class="step-indicator">Last step</p>`;
  }
  return renderPage(
    c,
    { title, body: html`<div class="container page narrow">${head}${content}</div>` },
    status,
  );
}

function verifyContent(
  user: User,
  code: string,
  errors: Record<string, string>,
  resent: boolean,
): Html {
  return html`<h1>Verify your email</h1>
    <p class="lede">
      We sent a 6-digit code to <strong>${user.email}</strong>. Enter it below to continue.
    </p>
    ${resent ? statusBanner('We sent a new code. It can take a minute to arrive.', 'info') : ''}
    ${errorSummary(errors)}
    <form class="form" method="post" action="/onboarding/verify" novalidate>
      ${textField({
        name: 'code',
        label: 'Verification code',
        value: code,
        error: errors['code'],
        hint: 'Six digits, no spaces.',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        maxlength: 6,
      })}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Verify and continue</button>
      </div>
    </form>
    <form method="post" action="/onboarding/verify/resend" class="form-footer">
      <p>Did not get it? <button type="submit" class="link-button">Resend code</button></p>
    </form>
    <aside class="dev-hint" aria-label="Developer note">
      Dev: your code is <code>${DEV_VERIFICATION_CODE}</code>
    </aside>`;
}

function profileContent(values: ProfileValues, errors: Record<string, string>): Html {
  return html`<h1>Tell us about your team</h1>
    <p class="lede">We use this to suggest the right roles and approval rules for your books.</p>
    ${errorSummary(errors)}
    <form class="form" method="post" action="/onboarding/profile" novalidate>
      ${profileFields(values, errors)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Continue</button>
      </div>
    </form>`;
}

function bankContent(bank: string, errors: Record<string, string>): Html {
  return html`<h1>Connect your business bank account</h1>
    <p class="lede">
      Ledgerly imports transactions automatically so your books are always current.
    </p>
    ${errorSummary(errors)}
    <form class="form" method="post" action="/onboarding/connect-bank" novalidate>
      ${radioGroup({
        name: 'bank',
        legend: 'Choose your bank',
        options: BANK_OPTIONS,
        value: bank,
        error: errors['bank'],
      })}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Connect bank</button>
      </div>
    </form>
    <p class="security-note">
      Read-only access through our banking partner. Ledgerly never moves money, and you can
      disconnect at any time.
    </p>
    <form method="post" action="/onboarding/connect-bank/skip">
      <button type="submit" class="link-button link-subtle">Skip for now</button>
    </form>`;
}

function inviteContent(
  user: User,
  values: Record<string, string>,
  errors: Record<string, string>,
): Html {
  return html`<h1>Invite your team</h1>
    <p class="lede">
      Add up to three teammates now, or do it later from Settings. They will get an email with a
      link to join ${user.company}.
    </p>
    ${errorSummary(errors)}
    <form class="form" method="post" action="/onboarding/invite" novalidate>
      ${INVITE_FIELDS.map((field, i) =>
        textField({
          name: field,
          label: `Teammate ${i + 1} email`,
          value: values[field] ?? '',
          error: errors[field],
          inputmode: 'email',
          autocomplete: 'off',
          required: false,
        }),
      )}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Continue</button>
      </div>
    </form>`;
}

function projectTitle(variant: Variant): string {
  return variant === 'treatment' ? 'Name your first project' : 'Create your first project';
}

function projectContent(
  variant: Variant,
  user: User,
  values: { name: string; currency: string },
  errors: Record<string, string>,
): Html {
  if (variant === 'treatment') {
    return html`<h1>Name your first project</h1>
      <p class="lede">
        We set up <strong>${user.company}</strong> with sensible defaults. You can change anything
        later in Settings.
      </p>
      ${errorSummary(errors)}
      <form class="form" method="post" action="/onboarding/project" novalidate>
        ${textField({
          name: 'name',
          label: 'Project name',
          value: values.name,
          error: errors['name'],
          hint: 'Base currency: US dollar. Change it any time in Settings.',
          maxlength: MAX_PROJECT_NAME,
        })}
        <input type="hidden" name="currency" value="${values.currency}" />
        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-lg">Create project</button>
        </div>
      </form>
      <p class="form-footer">
        Connect a bank and invite teammates whenever you like, from your dashboard.
      </p>`;
  }
  return html`<h1>Create your first project</h1>
    <p class="lede">
      A project holds the books for one company or entity. Most teams start with one.
    </p>
    ${errorSummary(errors)}
    <form class="form" method="post" action="/onboarding/project" novalidate>
      ${projectFields(values, errors)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Create project</button>
      </div>
    </form>`;
}
