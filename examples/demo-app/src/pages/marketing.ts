import { html } from 'hono/html';
import { EVENTS } from '../analytics.js';
import { renderPage, track } from '../context.js';
import type { App, Deps } from '../context.js';
import type { Html } from '../html.js';

export function registerMarketingRoutes(app: App, deps: Deps): void {
  app.get('/', (c) =>
    renderPage(c, { title: 'Bookkeeping your whole team can keep up with', body: landing() }),
  );

  app.get('/pricing', (c) => {
    track(c, deps, EVENTS.pricingViewed);
    return renderPage(c, { title: 'Pricing', body: pricing() });
  });

  app.get('/docs', (c) => renderPage(c, { title: 'Documentation', body: docs() }));
}

function landing(): Html {
  return html`<section class="hero">
      <div class="container">
        <h1>Bookkeeping your whole team can keep up with.</h1>
        <p class="lede">
          Ledgerly turns your bank feed into clean, categorized books and gives everyone who touches
          the money a role, a task list, and nothing to lose track of.
        </p>
        <div class="cta-row">
          <a class="btn btn-primary btn-lg" href="/signup">Start free</a>
          <a class="btn btn-secondary btn-lg" href="/pricing">See pricing</a>
        </div>
        <p class="fine-print">Free for one project. No credit card required.</p>
      </div>
    </section>

    <section id="features" class="section" aria-labelledby="features-heading">
      <div class="container">
        <h2 id="features-heading">Everything a small team needs to close the month</h2>
        <div class="grid-3">
          <article class="card">
            <h3>Bank sync that categorizes itself</h3>
            <p>
              Connect your business accounts once. Ledgerly imports transactions every night and
              learns your categories from the first few you correct.
            </p>
          </article>
          <article class="card">
            <h3>Roles for the whole team</h3>
            <p>
              Give your bookkeeper, your co-founder, and your accountant exactly the access they
              need. Approvals keep spending honest without slowing anyone down.
            </p>
          </article>
          <article class="card">
            <h3>A month-end checklist that runs itself</h3>
            <p>
              Reconcile, review, and lock each month with a guided checklist. Nothing slips, and
              your accountant gets clean books on the first.
            </p>
          </article>
        </div>
      </div>
    </section>

    <section class="section section-alt" aria-labelledby="pricing-teaser-heading">
      <div class="container pricing-teaser">
        <h2 id="pricing-teaser-heading">Simple pricing</h2>
        <p>
          Free for one project. Team plans from <strong>$29 per month</strong> with unlimited
          projects and automatic bank sync.
        </p>
        <a class="btn btn-secondary" href="/pricing">Compare plans</a>
      </div>
    </section>

    <section class="section" aria-labelledby="testimonials-heading">
      <div class="container">
        <h2 id="testimonials-heading">Teams that stopped dreading month-end</h2>
        <div class="grid-3">
          <figure class="quote">
            <blockquote>
              “We went from a shoebox of receipts to clean books in a weekend. Our accountant asked
              what changed.”
            </blockquote>
            <figcaption>Priya N., owner, Harbor Lane Coffee</figcaption>
          </figure>
          <figure class="quote">
            <blockquote>
              “The approval flow alone paid for itself. Nobody buys software without me seeing it
              first anymore.”
            </blockquote>
            <figcaption>Marcus T., co-founder, Fieldnote Studio</figcaption>
          </figure>
          <figure class="quote">
            <blockquote>
              “I keep books for nine clients. Ledgerly is the only tool where each one gets its own
              tidy project.”
            </blockquote>
            <figcaption>Dana R., bookkeeper, Rowe &amp; Co.</figcaption>
          </figure>
        </div>
      </div>
    </section>

    <section class="section cta-section" aria-labelledby="cta-heading">
      <div class="container">
        <h2 id="cta-heading">Ready to see your books in order?</h2>
        <p>Setup takes a few minutes. Cancel anytime.</p>
        <a class="btn btn-primary btn-lg" href="/signup">Start free</a>
      </div>
    </section>`;
}

function pricing(): Html {
  return html`<div class="container page">
    <h1>Pricing</h1>
    <p class="lede">Start free. Upgrade when your team grows.</p>

    <div class="tiers">
      <section class="tier" aria-labelledby="tier-starter">
        <h2 id="tier-starter">Starter</h2>
        <p class="price"><span class="amount">$0</span> <span class="per">forever</span></p>
        <ul>
          <li>1 project</li>
          <li>1 user</li>
          <li>CSV statement import</li>
          <li>Month-end checklist</li>
        </ul>
        <a class="btn btn-secondary" href="/signup?plan=starter">Start free</a>
      </section>
      <section class="tier tier-featured" aria-labelledby="tier-team">
        <p class="badge">Most popular</p>
        <h2 id="tier-team">Team</h2>
        <p class="price"><span class="amount">$29</span> <span class="per">per month</span></p>
        <ul>
          <li>Unlimited projects</li>
          <li>Up to 5 users with roles</li>
          <li>Automatic bank sync</li>
          <li>Spending approvals</li>
          <li>Email support</li>
        </ul>
        <a class="btn btn-primary" href="/signup?plan=team">Start 14-day trial</a>
      </section>
      <section class="tier" aria-labelledby="tier-business">
        <h2 id="tier-business">Business</h2>
        <p class="price"><span class="amount">$79</span> <span class="per">per month</span></p>
        <ul>
          <li>Everything in Team</li>
          <li>Unlimited users</li>
          <li>Multi-entity consolidation</li>
          <li>Accountant access and audit log</li>
          <li>Priority support</li>
        </ul>
        <a class="btn btn-secondary" href="/signup?plan=business">Start 14-day trial</a>
      </section>
    </div>

    <section class="faq" aria-labelledby="faq-heading">
      <h2 id="faq-heading">Frequently asked questions</h2>
      <details>
        <summary>Do I need a credit card to start?</summary>
        <p>
          No. Starter is free for one project, and trials of paid plans do not ask for a card until
          you decide to continue.
        </p>
      </details>
      <details>
        <summary>Which banks can I connect?</summary>
        <p>
          Most US business checking, savings, and credit card accounts, through our read-only
          banking partner. You can also import CSV statements from any bank.
        </p>
      </details>
      <details>
        <summary>Can my accountant log in?</summary>
        <p>
          Yes. Invite them with the Accountant role on Team or Business. They see the projects you
          share and nothing else.
        </p>
      </details>
      <details>
        <summary>What happens to my data if I cancel?</summary>
        <p>
          You keep read access for 90 days and can export every transaction, attachment, and report
          as CSV or PDF at any time.
        </p>
      </details>
      <details>
        <summary>Is there a discount for annual billing?</summary>
        <p>Yes. Annual billing takes two months off: Team is $290 per year, Business is $790.</p>
      </details>
    </section>
  </div>`;
}

function docs(): Html {
  return html`<div class="container page docs">
    <h1>Documentation</h1>
    <p class="lede">Everything you need to go from sign-up to a reconciled month.</p>
    <nav aria-label="On this page">
      <ul>
        <li><a href="#getting-started">Getting started</a></li>
        <li><a href="#projects">Projects</a></li>
        <li><a href="#banks">Bank connections</a></li>
        <li><a href="#team">Inviting your team</a></li>
        <li><a href="#exports">Exports and API</a></li>
      </ul>
    </nav>

    <section id="getting-started" aria-labelledby="getting-started-heading">
      <h2 id="getting-started-heading">Getting started</h2>
      <ol>
        <li><a href="/signup">Create an account</a> with your work email.</li>
        <li>Create a project for the company whose books you keep.</li>
        <li>Connect a bank, or import a CSV statement, to bring in transactions.</li>
      </ol>
    </section>

    <section id="projects" aria-labelledby="projects-heading">
      <h2 id="projects-heading">Projects</h2>
      <p>
        A project is one set of books: one legal entity, one base currency, one chart of accounts.
        Most small teams need a single project. Bookkeepers create one per client.
      </p>
    </section>

    <section id="banks" aria-labelledby="banks-heading">
      <h2 id="banks-heading">Bank connections</h2>
      <p>
        Connections are read-only; Ledgerly never moves money. Transactions sync nightly and are
        categorized by your rules first and our suggestions second. You can disconnect a bank at any
        time from Settings.
      </p>
    </section>

    <section id="team" aria-labelledby="team-heading">
      <h2 id="team-heading">Inviting your team</h2>
      <p>
        Invite teammates from the dashboard or from Settings. Roles are Owner, Finance, Bookkeeper,
        Accountant, and Viewer. Approvals can be required above a spending threshold you choose.
      </p>
    </section>

    <section id="exports" aria-labelledby="exports-heading">
      <h2 id="exports-heading">Exports and API</h2>
      <p>
        Export any project as CSV or PDF. A REST API with the same shapes is in private beta for
        Business customers.
      </p>
    </section>
  </div>`;
}
