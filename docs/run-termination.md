# Run termination: the time cap and the `termination` object

Every run ends with a typed `termination` object on its run record (`run.json` in local mode,
`GET /v1/runs/{id}` on the server, `agon run --json`). It says how the run ended, how long it
took against its cap, how much of the plan executed, and, when the run stopped early, what it
still produced. A run that hits its wall-clock cap is a **partial result, not a failure**, and
`agon run` exits with a code CI can map to "neutral".

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
| `time_cap_reached` | 3 | neutral: nothing is wrong with the product, the run was cut short |
| `infra_aborted` | 4 | neutral or failure of the pipeline, never of the product |
| `cancelled` | 5 | cancelled (not produced by `agon run` today; reserved for the server's cancel path) |

A config or usage error before the run starts exits 1 (or 4 when the adapter or model client
refused to start). The mapping is exported from `@agon/spec` as `TERMINATION_EXIT_CODES` /
`terminationExitCode(kind)` so wrappers and the GitHub Action can share it.

A GitHub Actions step, for example:

```sh
pnpm agon run agon.yaml --json > run.json; code=$?
case $code in
  0) ;;                       # compare and let the verdict decide
  3) echo "::notice::time cap reached: partial result" ; exit 0 ;;
  4) echo "::warning::infrastructure failed" ; exit 0 ;;
  *) exit $code ;;
esac
```

## `agon run --json`

The JSON output carries `termination`, `exitCode`, `counts` (with `interrupted`) and the usual
per-variant summary. The same object is stamped into `run.json`, where
`lastCompletedStage` becomes `export` once the local sinks closed without errors.
