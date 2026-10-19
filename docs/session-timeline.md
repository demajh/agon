# Session timeline: every planned session, whether or not it ran

When the time cap cuts a run ([run-termination.md](run-termination.md)), the run record says how
many sessions were planned, how many reached an outcome and how many were interrupted. It does
not, by itself, say which ones. excelsior, discussing capped runs on Moltbook, put the missing
piece plainly:

> I would retain, per planned session: variant and case, whether it started, its offset from run
> start, elapsed time until completion or interruption, and outcome status.

With those rows, per-variant totals and duration summaries are derived rather than reported, the
planned and started denominators stay visible next to them, and an interrupted session's duration
is marked as time observed so far rather than a runtime. The point of the exercise, in their
words, is that a reader can tell a variant whose cases ran slow from one that was scheduled late.

This page says where each of those fields lives in a recorded run today, and describes
`scripts/session-timeline.mjs`, which assembles them into one table per run.

## What the record holds, per planned session

A run directory written by `agon run` (`<out>/<runId>/`) carries two things that matter here.

`run.json` is the run record (`RunSchema` in `packages/spec/src/run.ts`). Its `startedAt` is the
moment the run's clock started, the same clock the cap counts from (locally, when `agon run`
began; on the server, when the run was queued). `counts` holds `planned`, `completed`, `failed`
and `interrupted`, and `termination` holds the kind, `elapsedMs` and `capMs`. The record also
snapshots the config, the seed and the variants.

`sessions.jsonl` holds one row per session that **started** (`SessionSchema` in
`packages/spec/src/session.ts`): `index`, `id`, `variant`, `scenarioId` (the case), `persona`,
`status`, `outcome`, `error`, `steps`, `startedAt`, `finishedAt`. The runner writes the row when the
session ends, whether it reached an outcome or was stopped at a step boundary by the cap.

A session that never started has no row anywhere. It does not need one: the plan is a pure function
of what `run.json` already holds. `planSessions` in `packages/engine/src/population/sampler.ts`
derives every session's variant, scenario, persona and id from the config snapshot, the seed, the
size and the run id (`deterministicId('ses', runId, index)`), so replaying it gives the never-started
rows their variant and case, and the replayed ids can be checked against the rows that were
recorded.

| field excelsior asked for | where it comes from                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variant and case          | the row's `variant` and `scenarioId`; for a session without a row, the replayed plan                                                                                                   |
| whether it started        | a row exists                                                                                                                                                                           |
| offset from run start     | `session.startedAt − run.startedAt`                                                                                                                                                    |
| elapsed time              | `session.finishedAt − session.startedAt`; a **runtime** when the session reached an outcome, **observed time so far** when the cap interrupted it                                       |
| outcome status            | `completed` (`status: finished`), `failed` (`status: failed` with an outcome), `interrupted` (`status: failed`, no outcome, `error: "run time cap reached"`), `never_started`, `no_record` |

`no_record` is the one status the counts force into the open: a session that threw before its row
was written is counted in `counts.failed` but has no row. The orchestrator dispatches sessions in
index order and every dispatched session yields either a row or a crash, so the dispatched count
(`completed + failed + interrupted`) splits the row-less indices exactly: below it they were
dispatched and left no record, at or above it they never started.

## The script

```sh
node scripts/session-timeline.mjs <runDir | outDir> [--json] [--config-dir <dir>]
```

It takes a run directory, or an output directory and uses its newest run as `agon trace` does.
`--config-dir` is the directory the run's `agon.yaml` lived in, needed only when the config refers
to persona files by relative path (built-in `builtin/...` personas resolve on their own). The replay
needs the workspace built (`pnpm build`); without it, or when the replayed plan disagrees with a
recorded row, the never-started rows are listed without a variant or case and the per-variant table
carries an `(unattributed)` line with their count, rather than a guess.

Output of a twelve-session run against a scripted site and a scripted model (the engine's
`@agon/engine/fakes`), with a 2.6 s cap and the treatment pages made slower to decide on:

```
run_1ctblrq4im10qacu ledgerly-timeline-demo: time_cap_reached after 2.8s (cap 2600 ms) · 12 planned, 6 started, 4 completed, 0 failed, 2 interrupted, 6 never started
  clock started 2026-10-19T00:33:19.021Z; the cap fired at 2026-10-19T00:33:21.621Z
  plan: replayed from run.json (seed 1, 12 sessions); session ids match the recorded rows

variant    planned  started  completed  failed  interrupted  never started  no record  runtime med/p90/max  observed med/p90/max  start offset first/med/last
control    6        3        2          0       1            3              0          0.7s/0.7s/0.7s       0.4s/0.4s/0.4s        0.0s/1.6s/2.3s
treatment  6        3        2          0       1            3              0          1.6s/1.6s/1.6s       0.5s/0.5s/0.5s        0.0s/0.7s/2.3s

#   session                     variant    case           status         start  elapsed      steps  outcome
0   ses_1ctblrq4im10qacu_00000  treatment  first-project  completed      0.0s   1.6s         6      success
1   ses_1ctblrq4im10qacu_00001  control    first-project  completed      0.0s   0.7s         6      success
2   ses_1ctblrq4im10qacu_00002  treatment  first-project  completed      0.7s   1.6s         6      success
3   ses_1ctblrq4im10qacu_00003  control    first-project  completed      1.6s   0.7s         6      success
4   ses_1ctblrq4im10qacu_00004  treatment  first-project  interrupted    2.3s   0.5s so far  2      none (interrupted)
5   ses_1ctblrq4im10qacu_00005  control    first-project  interrupted    2.3s   0.4s so far  3      none (interrupted)
6   ses_1ctblrq4im10qacu_00006  treatment  first-project  never started  —      —            —      —
7   ses_1ctblrq4im10qacu_00007  control    first-project  never started  —      —            —      —
…
```

Reading it the way excelsior intended: both variants had six sessions planned, three started and
three never started, so neither was scheduled late relative to the other. Treatment's completed
sessions took 1.6 s against control's 0.7 s with the same number of steps, so treatment **ran slow**.
Had the table instead shown equal runtimes but one variant with later first starts and more
never-started rows, that variant would have been **scheduled late**, and the cap, not the product,
would explain its thinner sample. The `partialDeltaManifest.sessionsPerVariant` in `run.json` shows
only the `2 / 2` that reached an outcome; the planned and started columns are what make the two
cases distinguishable.

The two interrupted rows carry `0.5s so far` and `0.4s so far`: each was stopped at the first step
boundary after the cap fired (2.3 s start plus two or three steps), and that figure is excluded from
the runtime columns, which summarize completed and failed sessions only. Variants interleave
round-robin in the plan, so in a single-process run the start offsets per variant drift apart only
when one variant's sessions hold the workers longer; the rows show it when it happens.

`--json` prints the same thing as data: `counts` for the run, one object per variant
(`planned`, `started`, `completed`, `failed`, `interrupted`, `neverStarted`, `noRecord`,
`runtimeMs` and `observedMs` as `{ n, median, p90, max }`, `startOffsetMs` as
`{ n, first, median, last }`) and one object per planned session (`index`, `sessionId`, `variant`,
`case`, `persona`, `status`, `started`, `startOffsetMs`, `elapsedMs`, `elapsedKind` of `runtime` or
`observed`, `steps`, `outcome`, `reason`). A dry run (`agon run --dry-run`) lists every planned
session as never started and says so in the header.

## What this does not do

- It reads the record as `agon run` writes it; the run record's schema is unchanged, and
  `counts.interrupted` and `termination` remain the authoritative summary. The per-session table is
  a derived view that any reader of `run.json` and `sessions.jsonl` can reproduce.
- A session cancelled through the server's cancel path is recorded with `outcome: error` and counted
  as failed, not interrupted, matching the orchestrator; its duration is a runtime.
- On the server, start offsets include queue time and cold start, because that is where the run's
  clock starts. A first session with a large offset there says the queue was slow, not the product.
- Quantiles use the nearest-rank rule, the same one `@agon/engine` uses for stall gaps, so a
  variant with two completed sessions reports its slower one as the p90 and its faster one as the
  median.
