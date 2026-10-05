# @agon/e2e

End-to-end proof that the pieces of Agon work together on a real browser and a real target. Every
other package tests itself against fakes; this one starts the Ledgerly demo app in-process, drives
it with the Playwright web adapter, and lets a scripted LLM play the user. It is the evidence for
the Phase 1 and Phase 2 gates in `PLAN.md` section 8.

Nothing here needs an API key or the network beyond `127.0.0.1`. The only external requirement is
Chromium for the pinned Playwright (`pnpm -F @agon/adapters exec playwright install chromium`) and,
for `agon compare`, the Python engine (`uv sync --project packages/stats`).

## What runs

| File | Proves |
| --- | --- |
| `src/engine.e2e.test.ts` | `runExperiment` plans a seeded population over both variants, opens one browser context per session, and every session reaches `event:project_created`. The treatment variant needs fewer steps and never shows the verification or bank pages. The app's own PostHog calls are intercepted, parsed, stamped with every simulation marker and attributed to the right session and variant; pageviews, clicks and the session lifecycle are inferred next to them; blocked analytics never leave the browser (an in-process "PostHog" sink receives zero requests); every step carries a real observation and a successful action; metrics and cost are computed per session. |
| `src/cli.e2e.test.ts` | The same experiment through the CLI: `agon run` on an `agon.yaml` with `${ENV}` URLs and built-in personas writes `run.json`, `sessions.jsonl`, `steps.jsonl`, `events.jsonl`, `manifest.json` and one PNG screenshot per step; `agon trace` lists the sessions and replays one; `agon compare` runs `agon-stats`, writes a `result.json` that validates against `ResultSchema`, sees the designed step difference, and prints the calibration note next to the lift. |

The scripted user lives in `src/ledgerly-user.ts`. It is a `UserPolicy` for `FakeLlm` from
`@agon/engine/fakes`: stateless, keyed on the page path and the accessible names the adapter
reports, so concurrent sessions can interleave. It signs up with a unique email, reads the
verification code from the page's dev hint, picks the first real option in every `<select>`, skips
the bank step, and declares `done` on the dashboard. Anything it does not recognise ends the
session with `give_up` and a reason, so a regression in the app, the adapter or the engine fails
loudly instead of looping to the step limit.

`src/demo.ts` starts a demo-app variant on an ephemeral port (`startDemoApp`) and the analytics
sink (`startAnalyticsSink`).

## Run it

```sh
pnpm build                       # tests run against built workspace packages
pnpm -F @agon/e2e test
AGON_SKIP_STATS_TESTS=1 pnpm -F @agon/e2e test   # without the Python engine
```

The whole suite takes well under a minute on a laptop. Set `AGON_LOG_LEVEL=debug` to see the
engine's log; the CLI test writes its run under a temporary directory and prints the path in the
`agon run` summary.

## Gaps this suite works around

Found while making the suite pass; each is a small change elsewhere, not here.

- **Unload-time analytics escape interception.** The demo app's shim batches events for 250 ms
  and flushes a pending batch on `pagehide` as a keepalive `fetch`. Chromium issues that request
  outside the page's network stack, so `context.route` in the web adapter neither captures nor
  blocks it: the event is lost and the request reaches the real host. posthog-js flushes the same
  way. The scripted user pauses 400 ms after typing before it submits a form (`REVIEW_PAUSE_MS`),
  which is what a person does anyway and lets the batch flush while the page is still alive.
- **Off-screen skip links are reported as clickable.** The app's "Skip to main content" link sits
  at `left: -999px` until focused. The adapter lists it as `[e1] link "Skip to main content"`, and
  clicking it cannot scroll it into view, so the action burns the full 10 s timeout. The scripted
  user matches the bank step's "Skip for now" button exactly, and gives up after any failed
  action rather than retrying.
- **`parsePrompt` drops filled values.** In `@agon/engine/fakes`, the ref regex only recognises
  "(empty)", never `(value: "…")`, so a `<select>` showing its placeholder is indistinguishable
  from one with a choice made. `readControls` re-reads the values from the raw prompt.
