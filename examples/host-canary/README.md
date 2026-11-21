# A run recorded beside a canary

The fixture behind [docs/host-canary.md](../../docs/host-canary.md): one run and the beats of a
heartbeat-only process that ran beside it on the same host. nim's question, from a Moltbook
conversation, was whether a run could carry "a canary writer per host that does nothing but beat,
so the pair always has a third neighbour that can't die of its own work". A run cannot carry one
today; `scripts/canary-beat.mjs` runs one beside it and reads the two records together.

| file | what |
|---|---|
| `beats.jsonl` | the canary's record: a `start` line, 32 beats 250 ms apart, an `end` line |
| `run_e3j4yknqiejn0xlr/run.json` | the run record: ten sessions planned, ten completed |
| `run_e3j4yknqiejn0xlr/sessions.jsonl` | one row per session |
| `run_e3j4yknqiejn0xlr/steps.jsonl` | one row per step, with `startedAt` and `durationMs` |
| `record.mjs` | the script that recorded all of the above |

```sh
node scripts/canary-beat.mjs read examples/host-canary --beats examples/host-canary/beats.jsonl --quiet-ms 1000
```

```
run_e3j4yknqiejn0xlr completed: 10 sessions wrote 142 timestamps; 2 quiet window(s) over 1.0s
  canary on fixture-host: 32 beats every 250 ms, late after 750 ms; it ran the command itself, so the two shared a host

#  from  to    quiet  in flight  beats  canary silent  verdict
1  1.1s  3.5s  2.4s   2          9      0.0s           writers_quiet
2  5.0s  7.5s  2.5s   2          1      2.5s           host_stall

  1 writers_quiet: the canary kept beating: the host kept time, look at what the writers share
  2 host_stall: the canary went silent with the writers: the host, not their work
      no beat from 4.8s to 7.5s: 2.7s by the wall clock, 2.7s by the monotonic clock
```

In both windows two sessions were in flight and neither wrote a row for about 2.5 s. The run
record cannot tell the windows apart. The canary beat nine times through the first and missed the
second with them. The one beat counted inside the second window is the late one that ended the
pause, a millisecond before the sessions wrote again.

With the default `--quiet-ms 5000` the report lists no window, because both stretches are shorter
than five seconds.

## How the fixture was produced

```sh
pnpm build
node examples/host-canary/record.mjs examples/host-canary/fixture
```

`record.mjs` starts the canary with `--interval-ms 250 --host fixture-host` and has it run the
run: the CLI's `runCommand` with concurrency 2 on the engine's offline fakes
(`@agon/engine/fakes`: `FakeLlm(happyUser)` against `ledgerlySite`), every model call taking
120 ms. Two things are then done to it on purpose:

1. From 1.0 s to 3.5 s after the run starts, every model call waits until the 3.5 s mark. Both
   sessions in flight go quiet on a host that is fine, as they would during a provider outage.
2. 5.0 s after the run's `startedAt`, the run's process and the canary's are both stopped with
   SIGSTOP, and continued 2.5 s later. Neither gets to run in between, which is what a stalled
   host does to them. It is a stand-in: no machine was suspended or starved to record this.

Nothing in the records was edited except the whitespace of `run.json`, which prettier reflowed.
`beats.jsonl` and the run directory were moved up out of the
directory they were recorded into; `events.jsonl`, `manifest.json`, the `agon.yaml` the recorder
wrote and the ledger directory were left out. The reader uses `events.jsonl` when it is there; the
verdicts above come from the step and session rows alone. `agon compare` needs the full directory and
is not meant to run on this one.

A new recording has a new run id, new timestamps and slightly different offsets; the two verdicts
are what `scripts/canary-beat.test.mjs` pins:

```sh
node --test scripts/canary-beat.test.mjs
```
