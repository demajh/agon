import { html } from 'hono/html';
import { EVENTS } from '../analytics.js';
import { currentUser, readForm, renderPage, track } from '../context.js';
import type { App, Deps } from '../context.js';
import { checkboxField, errorSummary, formatDate, statusBanner } from '../html.js';
import type { Html } from '../html.js';
import { dashboardSuggestions } from '../onboarding.js';
import type { SetupStep } from '../onboarding.js';
import type { Project, User } from '../store.js';
import { notFoundBody } from './errors.js';
import { profileFields, projectFields, validateProfile, validateProject } from './onboarding.js';

const SETUP_CARDS: Record<SetupStep, { title: string; text: string; cta: string }> = {
  verify: {
    title: 'Verify your email',
    text: 'Confirm your address so you can receive month-end reminders and invoices.',
    cta: 'Verify email',
  },
  profile: {
    title: 'Tell us about your team',
    text: 'Your role and team size help us suggest the right roles and approvals.',
    cta: 'Complete profile',
  },
  'connect-bank': {
    title: 'Connect a bank',
    text: 'Import transactions automatically instead of uploading statements.',
    cta: 'Connect a bank',
  },
  invite: {
    title: 'Invite teammates',
    text: 'Bring in your bookkeeper or co-founder with the right level of access.',
    cta: 'Invite teammates',
  },
};

export function registerAppRoutes(app: App, deps: Deps): void {
  app.get('/app', (c) => {
    const user = currentUser(c);
    const projects = deps.store.projectsForUser(user.id);
    track(c, deps, EVENTS.dashboardViewed, { projects: projects.length });
    return renderPage(c, {
      title: 'Dashboard',
      body: dashboard(user, projects, dashboardSuggestions(user), c.req.query('welcome') === '1'),
    });
  });

  app.get('/projects/new', (c) =>
    renderPage(c, {
      title: 'New project',
      body: newProjectContent({ name: '', currency: '' }, {}),
    }),
  );

  app.post('/projects/new', async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const values = { name: form['name'] ?? '', currency: form['currency'] ?? '' };
    const errors = validateProject(values);
    if (Object.keys(errors).length > 0) {
      return renderPage(c, { title: 'New project', body: newProjectContent(values, errors) }, 400);
    }
    const variant = c.get('variant');
    const project = deps.store.createProject({
      userId: user.id,
      name: values.name,
      currency: values.currency,
      variant,
    });
    track(c, deps, EVENTS.projectCreated, {
      variant,
      project_id: project.id,
      currency: project.currency,
      source: 'projects_new',
    });
    return c.redirect(`/projects/${project.id}`, 303);
  });

  app.get('/projects/:id', (c) => {
    const user = currentUser(c);
    const project = deps.store.getProject(c.req.param('id'));
    if (!project || project.userId !== user.id) {
      return renderPage(c, { title: 'Page not found', body: notFoundBody(c.req.path) }, 404);
    }
    return renderPage(c, { title: project.name, body: projectContent(project) });
  });

  app.get('/app/settings', (c) => {
    const user = currentUser(c);
    const saved = c.req.query('saved') === '1';
    return renderPage(c, {
      title: 'Settings',
      body: settingsContent(user, deps.store.projectsForUser(user.id), saved, {}),
    });
  });

  app.post('/app/settings/profile', async (c) => {
    const user = currentUser(c);
    const { values, errors } = validateProfile(await readForm(c));
    if (Object.keys(errors).length > 0) {
      return renderPage(
        c,
        {
          title: 'Settings',
          body: settingsContent(user, deps.store.projectsForUser(user.id), false, errors),
        },
        400,
      );
    }
    user.profile = { role: values.role, teamSize: values.team_size };
    return c.redirect('/app/settings?saved=1', 303);
  });

  app.post('/app/settings/delete', async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    if (form['confirm_delete'] !== 'yes') {
      const errors = { confirm_delete: 'Tick the box to confirm you want to delete your account.' };
      return renderPage(
        c,
        {
          title: 'Settings',
          body: settingsContent(user, deps.store.projectsForUser(user.id), false, errors),
        },
        400,
      );
    }
    deps.store.deleteUser(user.id);
    c.set('user', undefined);
    return c.redirect('/', 303);
  });
}

function dashboard(
  user: User,
  projects: Project[],
  suggestions: SetupStep[],
  welcome: boolean,
): Html {
  return html`<div class="container page">
    <h1>Dashboard</h1>
    <p class="lede">Welcome back, ${user.company}.</p>
    ${
      welcome
        ? statusBanner(
            'Your first project is ready. Connect a bank when you want transactions to start flowing in.',
          )
        : ''
    }
    ${
      suggestions.length > 0
        ? html`<section aria-labelledby="setup-heading">
            <div class="section-head"><h2 id="setup-heading">Finish setting up</h2></div>
            <div class="setup-cards">
              ${suggestions.map((step) => {
                const card = SETUP_CARDS[step];
                return html`<article class="setup-card">
                  <h3>${card.title}</h3>
                  <p>${card.text}</p>
                  <a class="btn btn-secondary" href="/onboarding/${step}">${card.cta}</a>
                </article>`;
              })}
            </div>
          </section>`
        : ''
    }
    <section aria-labelledby="projects-heading">
      <div class="section-head">
        <h2 id="projects-heading">Projects</h2>
        <a class="btn btn-secondary" href="/projects/new">New project</a>
      </div>
      ${
        projects.length === 0
          ? html`<p class="empty">
              No projects yet. <a href="/projects/new">Create your first project</a>.
            </p>`
          : html`<ul class="card-list">
              ${projects.map(
                (p) =>
                  html`<li class="project">
                    <div>
                      <h3><a href="/projects/${p.id}">${p.name}</a></h3>
                      <p class="meta">
                        ${p.currency} · Created ${formatDate(p.createdAt)} · No transactions yet
                      </p>
                    </div>
                    <a class="btn btn-ghost" href="/projects/${p.id}">Open</a>
                  </li>`,
              )}
            </ul>`
      }
    </section>
  </div>`;
}

function newProjectContent(
  values: { name: string; currency: string },
  errors: Record<string, string>,
): Html {
  return html`<div class="container page narrow">
    <p class="step-indicator"><a href="/app">Dashboard</a> › New project</p>
    <h1>New project</h1>
    <p class="lede">A project holds the books for one company or entity.</p>
    ${errorSummary(errors)}
    <form class="form" method="post" action="/projects/new" novalidate>
      ${projectFields(values, errors)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Create project</button>
        <a href="/app">Cancel</a>
      </div>
    </form>
  </div>`;
}

function projectContent(project: Project): Html {
  return html`<div class="container page">
    <p class="step-indicator"><a href="/app">Dashboard</a> › ${project.name}</p>
    <h1>${project.name}</h1>
    <p class="meta">Base currency ${project.currency} · Created ${formatDate(project.createdAt)}</p>
    <section aria-labelledby="transactions-heading">
      <div class="section-head"><h2 id="transactions-heading">Transactions</h2></div>
      <p class="empty">
        No transactions yet. <a href="/onboarding/connect-bank">Connect a bank</a> to import them
        automatically.
      </p>
    </section>
  </div>`;
}

function settingsContent(
  user: User,
  projects: Project[],
  saved: boolean,
  errors: Record<string, string>,
): Html {
  const profile = { role: user.profile?.role ?? '', team_size: user.profile?.teamSize ?? '' };
  return html`<div class="container page">
    <h1>Settings</h1>
    ${saved ? statusBanner('Your changes were saved.') : ''} ${errorSummary(errors)}

    <section class="settings-section" aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>
      <dl class="details">
        <dt>Email</dt>
        <dd>
          ${user.email}${user.verified ? '' : html` · <a href="/onboarding/verify">Verify email</a>`}
        </dd>
        <dt>Company</dt>
        <dd>${user.company}</dd>
        <dt>Plan</dt>
        <dd>Starter (free)</dd>
        <dt>Projects</dt>
        <dd>${projects.length}</dd>
      </dl>
    </section>

    <section class="settings-section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <form class="form" method="post" action="/app/settings/profile" novalidate>
        ${profileFields(profile, errors)}
        <button type="submit" class="btn btn-primary">Save profile</button>
      </form>
    </section>

    <section class="settings-section" aria-labelledby="bank-heading">
      <h2 id="bank-heading">Bank connection</h2>
      ${
        user.bank
          ? html`<p>
              Connected to <strong>${user.bank.bank}</strong> since
              ${formatDate(user.bank.connectedAt)}.
            </p>`
          : html`<p>
              No bank connected. <a href="/onboarding/connect-bank">Connect a bank</a> to import
              transactions automatically.
            </p>`
      }
    </section>

    <section class="settings-section" aria-labelledby="team-heading">
      <h2 id="team-heading">Team</h2>
      ${
        user.invites.length > 0
          ? html`<ul>
              ${user.invites.map((email) => html`<li>${email} <span class="meta">(invited)</span></li>`)}
            </ul>`
          : html`<p>No teammates yet.</p>`
      }
      <p><a href="/onboarding/invite">Invite teammates</a></p>
    </section>

    <section class="settings-section" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete account</h2>
      <div class="danger-zone">
        <p>
          This permanently deletes your account, every project, and all transactions. It cannot be
          undone.
        </p>
        <form method="post" action="/app/settings/delete" novalidate>
          ${checkboxField({
            name: 'confirm_delete',
            label: 'I understand this permanently deletes all of my books',
            error: errors['confirm_delete'],
          })}
          <button type="submit" class="btn btn-danger">Delete account</button>
        </form>
      </div>
    </section>
  </div>`;
}
