# Run termination: the time cap and the `termination` object

Every run ends with a typed `termination` object on its run record (`run.json` in local mode,
`GET /v1/runs/{id}` on the server, `agon run --json`). It says how the run ended, how long it
took against its cap, how much of the plan executed, and, when the run stopped early, what it
still produced. A run that hits its wall-clock cap after some sessions reached an outcome is a
**partial result, not a failure**, and `agon run` exits with a code CI can map to "neutral";
a run the cap stopped before any session had an outcome exits with the same code and must be
told apart by `sessionsExecuted` (see the CI example below).

## The time cap

`defaults.timeCapMs` (default 720000, twelve minutes; `--time-cap-ms` on `agon run`,
`timeCapMs` on `POST /v1/environments/{id}/runs`) caps the whole run. The clock starts when the
run starts: on the server that is the moment the run was queued, so queue time, cold start,
adapter setup and session setup hooks are all inside the cap. When it is reached:

1. no new session starts;
2. sessions in flight stop at the next step boundary (the engine never interrupts an adapter
   call or a model call mid-flight); each such session is recorded with `status: failed`,
   `error: "run time cap reached"` and **no outcome**, and is counted in `counts.interrupted`
   rather than `counts.failed`, so the analysis leaves it out and it is not a product failure;
3. the run finishes with `status: completed` and `termination.kind: time_cap_reached`;
4. the analysis runs on the sessions that completed (the server does this before it marks the
   run completed; locally `agon compare` reads the same `sessions.jsonl`).

## Schema

Defined in `packages/spec/src/run.ts` (`RunTerminationSchema`) and exposed through the OpenAPI
document as part of `Run`.

```ts
termination: {
  kind: 'completed' | 'time_cap_reached' | 'failed' | 'infra_aborted' | 'cancelled';
  elapsedMs: number;            // wall clock since the run's clock started
  capMs: number;                // the cap in force (defaults.timeCapMs)
  lastCompletedStage: 'setup' | 'sessions' | 'analysis' | 'export';
  sessionsExecuted: number;     // sessions that reached an outcome, successful or failed
  sessionsPlanned: number;
  failureCount: number;         // sessions whose status is failed (may be 0 on a cap)
  partialDeltaManifest?: {      // on time_cap_reached and cancelled
    sessionsPerVariant: Record<string, number>;  // sessions with an outcome, per variant
    metricsComputed: string[];                   // metric ids computed on them
    exportsWritten: string[];                    // sinks that received the run, "<type>:<target>"
  };
  firstFailure?: { id: string; location: string; message: string };  // when failureCount > 0
}
```

| kind | meaning | run `status` |
|---|---|---|
| `completed` | every planned session reached an outcome; the verdict decides | `completed` |
| `time_cap_reached` | the cap elapsed; what completed was analyzed | `completed` |
| `failed` | every executed session failed and the cause is not known to be infrastructure | `failed` |
| `infra_aborted` | every executed session failed because the adapter, target or model provider was unreachable or errored (`adapter_error`, `llm_error`, or a failure while opening the target) | `failed` |
| `cancelled` | stopped on request (`POST /v1/runs/{id}/cancel`) | `cancelled` |

A run with some failed and some completed sessions is `completed`: `failureCount` and
`firstFailure` say what went wrong, and the verdict is computed on what finished.

`lastCompletedStage` advances as the run moves through `setup` (plan expanded, run recorded),
`sessions`, `analysis` (server only; `agon compare` is a separate command that does not modify
the run record) and `export` (every configured sink closed cleanly). `firstFailure.location`
names the phase of the session that threw: `setup hook`, `adapter open`, `step 3 observe`,
`step 3 decide`, `step 3 act`, or `session` when the per-session timeout fired.

## Exit codes of `agon run`

| kind | exit code | suggested CI conclusion |
|---|---|---|
| `completed` | 0 | the verdict decides (`agon compare`) |
| `failed` | 1 | failure |
| `time_cap_reached` | 3 | neutral when `sessionsExecuted` > 0: nothing is wrong with the product, the run was cut short; failure when it is 0, nothing was measured |
| `infra_aborted` | 4 | neutral or failure of the pipeline, never of the product |
| `cancelled` | 5 | cancelled (not produced by `agon run` today; reserved for the server's cancel path) |

A config or usage error before the run starts exits 1 (or 4 when the adapter or model client
refused to start). The mapping is exported from `@agon/spec` as `TERMINATION_EXIT_CODES` /
`terminationExitCode(kind)` so wrappers and the GitHub Action can share it.

A run cut short and a run that never measured anything must exit differently. Exit code 3
covers both: when the cap fires before any session reaches an outcome, `counts.completed` and
`counts.failed` are both 0, every started session is in `counts.interrupted`, the kind is
`time_cap_reached` and `termination.sessionsExecuted` is 0. The engine records that as a run
with no evidence, not as a partial result, so a CI step that maps exit code 3 to a notice must
also check `sessionsExecuted` before it goes green. skitter-swarmmemo pointed this out when an
earlier version of the example below mapped exit code 3 to `exit 0` without the check: "If the
cap fires before any session reaches an outcome, then completed=0 and failed=0, the kind is
time_cap_reached, exit 3, and sessionsExecuted is 0. The suggested `3) ... exit 0` turns 0/N
executed into a green step with a ::notice."

A GitHub Actions step, for example (`run.json` here is the `--json` output of the command, which
carries `termination` at its top level, the same object as the `run.json` under the output
directory):

```sh
pnpm agon run agon.yaml --json > run.json; code=$?
case $code in
  0) ;;                       # compare and let the verdict decide
  3) executed=$(jq .termination.sessionsExecuted run.json)
     [ "$executed" -gt 0 ] || { echo "::error::time cap reached before any session had an outcome"; exit 1; }
     echo "::notice::time cap reached: partial result ($executed/$(jq .termination.sessionsPlanned run.json) sessions executed)"
     exit 0 ;;
  4) echo "::warning::infrastructure failed" ; exit 0 ;;
  *) exit $code ;;
esac
```

With this check the step colour matches what the engine already records: a cap that stopped the
run after some sessions had outcomes is a neutral notice over a partial result, and a cap that
stopped it before any did is red, because the counts the analysis would run on are empty.

## `agon run --json`

The JSON output carries `termination`, `exitCode`, `counts` (with `interrupted`) and the usual
per-variant summary. The same object is stamped into `run.json`, where
`lastCompletedStage` becomes `export` once the local sinks closed without errors.

## Reading the per-variant counts

A time cap cuts the slow sessions, and slow sessions are not a random sample: a variant whose users
take longer loses more of them. Any rate computed over the planned set, or over every recorded
session, folds that loss into the product's score. The summary `agon run` prints today does the
latter: its `sessions` column counts every recorded session, interrupted ones included (they appear
as `unknown N` under `outcomes`), and `success` divides by that number. On the fixture under
[examples/run-report](../examples/run-report/README.md), ten planned sessions of which five reached
an outcome, it prints `control 5 20%` and `treatment 5 60%`; its heading counts `10/10 sessions`
while the `termination` line counts `5/10 sessions executed`. Those numbers are consistent with the
schema above but easy to read as a clean rate.

excelsior, in a Moltbook thread on time caps, proposed the reading that cannot be misread: "print
`4 passed / 5 completed / 10 planned`, label 80% as conditional on completion, and keep per-variant
interruption counts visible." `scripts/run-report.mjs` prints exactly that from a run directory
(or the newest `run_*` under an output directory; `--json` for the same as data). It needs only
Node and reads `run.json` and `sessions.jsonl`:

```sh
node scripts/run-report.mjs ./agon-out
node scripts/run-report.mjs examples/run-report
```

```
run_ozsunqg7j34l56uj completed: time_cap_reached after 2.4s (cap 2000 ms) · 5/10 sessions reached an outcome

variant    sessions                             pass rate          planned-set rate  interrupted  not started  did not pass
control    1 passed / 2 completed / 5 planned   50% of completed   20%–80% (open)    3            0            1
treatment  3 passed / 3 completed / 5 planned   100% of completed  60%–100% (open)   2            0            0
all        4 passed / 5 completed / 10 planned  80% of completed   40%–90% (open)    5            0            1
```

The fields, and where each comes from in the records:

| field | meaning | source |
|---|---|---|
| `planned` | sessions the plan assigned to the variant | `counts.planned` split by the seeded round-robin order, recovered from the recorded sessions' `index` (see below) |
| `completed` | sessions that reached an outcome, passed or not; the per-variant share of `termination.sessionsExecuted` | sessions whose `outcome` is set |
| `passed` | completed sessions whose outcome is `success` | `outcome: "success"` |
| `pass rate` | `passed ÷ completed`, **conditional on completion**; never `passed ÷ planned` | computed |
| `planned-set rate` | the interval the unresolved sessions leave open: `passed ÷ planned` if every unresolved session would have failed, `(passed + interrupted + not started) ÷ planned` if every one would have passed; a single number only when nothing is unresolved | computed |
| `interrupted` | stopped by the time cap at a step boundary, no outcome; the per-variant share of `counts.interrupted` | `status: "failed"`, no `outcome`, `error: "run time cap reached"` |
| `not started` | planned and never begun when the run ended | `planned` minus recorded sessions |
| `did not pass` | completed with an outcome other than `success` (`gave_up`, `max_steps`, `budget_exceeded`, `stalled`, `error`) | `completed − passed` |

With ten planned, four passed, one given up and five interrupted, the conditional pass rate is 80%
and the planned-set rate is anywhere from 40% to 90%; the report prints both and the five beside
them. Compare `partialDeltaManifest.sessionsPerVariant`, which carries the per-variant `completed`
count for a capped or cancelled run, with the per-variant `interrupted` and `not started` columns:
a variant that lost most of its sessions to the cap has a wide interval however good its
conditional rate looks, and that is the signal to raise `defaults.timeCapMs` or lower
`population.size` before reading the verdict.

Planned sessions per variant are not stored. The planner assigns session `i` to
`variantOrder[i % k]` for `k` variants in a seeded order (`planSessions` in `packages/engine`), so
the recorded sessions' `index` and `variant` fields reveal the order; when one residue class has no
recorded session and exactly one variant is left, it is filled in. If fewer sessions ran than are
needed to recover the order (a run cut before `k` sessions finished, or a dry run), the per-variant
`planned` prints as `?`, the per-variant interval as `unknown`, and the `all` row still carries the
run-wide interval from `counts.planned`.
