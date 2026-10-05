# @agon/demo-app — Ledgerly

Ledgerly is a fictional bookkeeping product for small teams. It exists so Agon has something
realistic to run simulated users against: server-rendered HTML, accessible markup, real
validation errors, and two deliberately different onboarding flows behind one codebase.

| | control | treatment |
| --- | --- | --- |
| After signup | `/onboarding/verify` → `/onboarding/profile` → `/onboarding/connect-bank` → `/onboarding/invite` → `/onboarding/project` | `/onboarding/project` |
| Verification | Mandatory 6-digit code; the code is on the page in a low-contrast "Dev: your code is 482913" hint | Deferred; an optional "Verify email" card on the dashboard |
| Bank connection | Mandatory step with a small "Skip for now" link | Optional dashboard card |
| Profile, invites | Mandatory steps | Optional dashboard cards |
| Project form | Empty name, currency to choose | Name prefilled from the company, one "Create project" button |
| POSTs to `project_created` | 5 | 1 |

Everything else (landing, pricing, docs, signup, dashboard, settings) is identical, so the
experiment isolates the onboarding design.

## Run it

```sh
pnpm install                                 # once, at the repo root
VARIANT=control   PORT=3001 pnpm -F @agon/demo-app dev
VARIANT=treatment PORT=3002 pnpm -F @agon/demo-app dev   # second terminal
```

`VARIANT` fixes the variant for the process (default `control`). For a single-process demo, add
`?variant=treatment` (or `?variant=control`) to any URL: the choice is stored in a cookie for that
browser, and `?variant=` clears it. The rendered `<html>` carries `data-variant`.

Environment: `PORT` (3000), `VARIANT`, `POSTHOG_HOST` (default `https://us.i.posthog.com`),
`POSTHOG_KEY` (any string; the default is a placeholder token), `HOST` (bind address, default
`0.0.0.0`).

Production build: `pnpm -F @agon/demo-app build && VARIANT=control pnpm -F @agon/demo-app start`.

### Docker

The build context must be the repository root (the lockfile lives there):

```sh
docker build -f examples/demo-app/Dockerfile -t agon-demo-app .
docker run --rm -p 3001:3000 -e VARIANT=control   agon-demo-app
docker run --rm -p 3002:3000 -e VARIANT=treatment agon-demo-app
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /`, `/pricing`, `/docs` | Marketing. `/pricing` emits `pricing_viewed`. |
| `GET/POST /signup` | Email, password, company. Errors: invalid email, weak password, `taken@example.com` is always taken. |
| `GET/POST /login`, `POST /logout` | Session management. |
| `GET/POST /onboarding/verify` (+ `/resend`) | Code is always `482913`. |
| `GET/POST /onboarding/profile` | Role and team size. |
| `GET/POST /onboarding/connect-bank` (+ `POST /skip`) | Pick a bank, or skip (`onboarding_skipped`). |
| `GET/POST /onboarding/invite` | Up to three optional emails. |
| `GET/POST /onboarding/project` | Creates the first project → `project_created`. |
| `GET /app` | Dashboard: projects plus optional setup cards. Emits `dashboard_viewed`. |
| `GET/POST /projects/new`, `GET /projects/:id` | More projects. |
| `GET /app/settings` (+ `POST /profile`, `POST /delete`) | Account, profile, bank, team, delete account. |

Logged-out visitors to `/app*`, `/projects*` or `/onboarding/*` are sent to `/login?next=…`.
Until the variant's required steps are done, `/app` and `/projects*` redirect to the next step;
in control, later steps are unreachable out of order.

### Test and inspection endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | `{ ok, variant, defaultVariant, uptimeMs }` |
| `POST /__reset` | Clears users, projects, sessions and the event log. `scripts/reset.sh` |
| `POST /__test-user` | Creates a verified user, returns `{ email, password, loginUrl }`. Optional JSON body: `{ "verified": false, "onboarded": true, "email": "...", "company": "..." }`. `scripts/create-test-user.sh` |
| `GET /__events` | Server-side event log as a JSON array; `?event=<name>` filters. |

State is in memory and per process. There is no persistence and no CSRF protection; this is a
test target, not a product.

## Analytics

The page loads `/static/analytics.js`, an ~80-line shim that mimics the posthog-js wire format
so Agon's web adapter can intercept the app's own analytics:

- `window.posthog = { init, capture, identify, register, flush, get_distinct_id }`.
- `$pageview` is captured on load with `$current_url`; the layout registers `variant` as a super
  property and calls `identify(userId)` for logged-in users.
- Events are batched (250 ms) and POSTed as `[{ event, properties: { distinct_id, $current_url,
  token, … }, timestamp, uuid }]`. Batches alternate between
  `POST ${POSTHOG_HOST}/e/?ip=1&_=<ts>` with a JSON array body (`application/json`) and
  `POST ${POSTHOG_HOST}/capture/` with `data=<base64 JSON>` (`application/x-www-form-urlencoded`),
  so an interceptor has to handle both decoders.

Product events: `pricing_viewed`, `signup_started` (first field focused), `signup_completed`,
`onboarding_step_completed { step }`, `onboarding_skipped { step }`, `project_created { variant }`,
`dashboard_viewed`. Every one of them is also written to the server-side log at `GET /__events`
(with `variant`, `session_id`, `$current_url`), so tests do not need a browser. Server-emitted
events are handed to the shim on the next rendered page, so browser and server logs agree.

## Running Agon against it

`agon.yaml` in this directory describes the experiment: a `web` target with the two variants
(`DEMO_CONTROL_URL` / `DEMO_TREATMENT_URL`, defaulting to ports 3001 and 3002), PostHog
interception, a seeded population of 40 built-in personas, the `first-project` scenario whose
success is `event:project_created`, and activation / time-to-activate / steps / frustration
metrics with a Bayesian analysis.

## Development

```sh
pnpm -F @agon/demo-app typecheck
pnpm -F @agon/demo-app test        # vitest, offline, via app.request()
pnpm -F @agon/demo-app build
```

Source layout: `src/app.ts` (`createApp`, middleware, infra routes), `src/pages/*` (route
groups), `src/store.ts` (in-memory state), `src/onboarding.ts` (which steps each variant
requires), `src/analytics.ts` (event names and the browser shim), `src/html.ts` (layout, CSS,
form components), `src/main.ts` (HTTP server).
