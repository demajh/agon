# A heartbeat-only sibling per host

When every session of a run stops writing at the same moment, the record alone cannot say why.
The sessions may each be waiting on their own work, or the host under all of them may have
stopped giving them time. nim, in a Moltbook conversation about writers that go quiet together,
proposed the cheap way to tell the two apart:

> cheap fix is a canary writer per host that does nothing but beat, so the pair always has a
> third neighbour that can't die of its own work. could an agon run carry a no-op sibling like
> that?

**A run cannot carry one today.** This page says what a run does record, why a sibling inside the
run would be the weaker design anyway, and how to put one beside a run with
`scripts/canary-beat.mjs`, which also reads the two records together.

## What a run records, and what it does not

The writers of a run are its sessions. Each leaves timestamps as it works (the JSONL sink,
`<out>/<runId>/`):

| file | written | timestamps |
|---|---|---|
| `steps.jsonl` | one row when a step ends | `startedAt`, `durationMs` |
| `events.jsonl` | as events are captured | `timestamp` |
| `sessions.jsonl` | one row when a session ends | `startedAt`, `finishedAt` |
| `run.json` | at the start, rewritten at the end | `startedAt`, `finishedAt` |

Nothing else beats. There is no heartbeat in the run record, the `Recorder` interface in
`@agon/spec` has no call for one (`runStarted`, `sessionStarted`, `step`, `events`,
`sessionFinished`, `runFinished`), `agon run` has no flag for a sibling, and `agon.yaml` has no
key for one. The run record names no host either. A step that is still waiting on a model call
or an adapter call has written nothing yet, so a quiet stretch shows only as a hole between two
rows, and a hole reads the same whatever caused it.

The three stops a session has (`maxSteps`, `budgetUsd`, `stallSteps`) and the run's time cap
([run-termination.md](run-termination.md)) all count steps or wall-clock time. None of them
separates a host that stalled from work that stalled. The cap in particular counts from the run's
start by the wall clock, so time a stalled host took is inside `termination.elapsedMs` and can
push a run into `time_cap_reached` without any session having been slow.

## Why the sibling belongs outside the run

All sessions of a run share one Node process: `runExperiment` starts up to
`defaults.maxConcurrency` worker loops (`--concurrency` on `agon run`, `AGON_CONCURRENCY` on the
server) inside the process that called it, and one server worker process executes a whole run. A
no-op session inside the run would share that process. It could not die of its own work, which is
nim's condition, but it would die of the run's: the time cap, a cancel, a crash, or a blocked
event loop would silence it together with the real sessions, and its silence would then say
nothing about the host.

A separate process shares only the host with the run. That is the neighbour nim describes, so
that is what the script provides.

## The canary

```sh
node scripts/canary-beat.mjs beat --out beats.jsonl [--interval-ms 1000] [--host <label>] [-- <command...>]
```

It appends one line per interval to `--out`, fsynced, and does nothing else: no model call, no
adapter, no session, no dependency beyond Node. A budget, a provider outage, the time cap and a
session timeout cannot reach it.

With a command after `--` it starts that command, beats beside it, stops when the command exits
and exits with the command's exit code, so the exit codes of `agon run` still reach CI:

```sh
node scripts/canary-beat.mjs beat --out agon-out/beats.jsonl -- pnpm agon run agon.yaml
```

Without a command it beats until it receives SIGINT or SIGTERM. One free-running canary per host
serves every run on that host, including the runs of a server worker (`AGON_ROLE=worker` or
`all`); start it on the machine the worker runs on.

The file is JSONL with three kinds of line:

```json
{"kind":"start","host":"fixture-host","pid":13371,"intervalMs":250,"t":"2026-11-21T01:35:50.168Z","command":["node","examples/host-canary/record.mjs","--run","examples/host-canary/fixture"],"childPid":13373}
{"kind":"beat","seq":1,"t":"2026-11-21T01:35:50.420Z","monoMs":251,"lateMs":1}
{"kind":"end","t":"2026-11-21T01:36:00.213Z","beats":32,"reason":"command_exit","exitCode":0}
```

`host` is `os.hostname()` unless `--host` names it. `monoMs` is Node's monotonic clock since the
canary started and `lateMs` is how far past its slot the beat fired. Beats sit on a fixed
schedule; a beat that fires late skips the slots it missed and never makes them up, so a stall
stays a gap in the file. An `end` line is written on a clean stop only. A canary that was killed,
or whose host went down, leaves none, and the reader uses that.

## Reading a run against its canary

```sh
node scripts/canary-beat.mjs read <runDir | outDir> --beats beats.jsonl [--quiet-ms 5000] [--late-ms <n>] [--json]
```

The reader collects every timestamp any session wrote (the table above; `events.jsonl` is used
when present) and reports each **quiet window**: a stretch longer than `--quiet-ms` between two
consecutive timestamps of the whole run, that is, a stretch in which all the sessions in flight
were silent together. A session that goes quiet while another keeps writing is not reported: the
writing neighbour already shows the host was up, which is the case that needs no canary.

Each window is then judged by what the canary did across it. A pause between two beats longer
than `--late-ms` (default three intervals) counts as canary silence.

| verdict | the canary | reading |
|---|---|---|
| `writers_quiet` | beat through the whole window | the host kept time; the cause is in the writers' work or in something they share other than the host |
| `host_stall` | was silent for at least half of the window | the third neighbour went quiet with them: the host, not their work |
| `mixed` | was silent for less than half of it | the host explains only that part |
| `unobserved` | has no beat on both sides of the window | nothing tells the two apart; the reader does not guess |

A run with no `finishedAt` in `run.json` was killed or lost its host. Its last window is open,
running from the last timestamp any session wrote, and is judged by what the canary did next:

| verdict | the canary | reading |
|---|---|---|
| `writers_quiet` | kept beating for longer than `--quiet-ms` afterwards | the run stopped writing on a live host |
| `command_exited` | ran the command and recorded its exit | the process died; the host was up to write that down |
| `host_stall` | stops where the sessions do, with no `end` line | they stopped together |
| `unobserved` | was stopped on purpose, or was never there | no evidence either way |

The reader exits 0 with a report, 1 when the run or the beats cannot be read, 2 on a usage error.
`--json` prints the same report as data: the canary's start line and beat count, and per window
`from`, `to`, `quietMs`, `open`, `inFlight` (session ids), `beats`, `silentMs`, `pauses` and
`verdict`.

## A recorded example

[examples/host-canary](../examples/host-canary/README.md) holds a real run of ten sessions, two at
a time, recorded beside a canary beating every 250 ms. Two quiet stretches were made on purpose:
for 2.5 s every model call waited while the host was fine, and later the run's process and the
canary's were both stopped for 2.5 s and continued.

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

Without the beats the two windows are the same thing in the record: two sessions in flight, about
2.5 s with no row from either. With them, the first is the writers' and the second is the host's.

## What this does not settle

- **It is beside the run, not in it.** Nothing in Agon starts the canary, stores its beats or
  links them to a run. The beats are a file the operator keeps; the run record is unchanged.
- **A free-running canary's host is the operator's word.** `run.json` names no host, so the reader
  cannot check that the beats and the run came from the same machine. A canary that ran the
  command itself shares its host by construction, and the report says which of the two it was.
- **`writers_quiet` is not one cause.** The canary rules the host out and nothing more. Two
  sessions waiting on one model provider, on one target, or behind a blocked event loop in the
  run's own process all read `writers_quiet`. The step rows around the window (`agon trace`) say
  which call each session was in.
- **The canary shares the host's disk.** A full or failing disk stops its beats too. That is a host
  condition and reads as one, but it is not a CPU stall.
- **Wall clocks.** Windows and beats are compared by wall-clock timestamps. A clock step during a
  run moves both records together, since they share the host's clock. The second figure on a
  pause line is the monotonic clock, which on Linux does not advance while the machine is
  suspended: a pause far longer by the wall clock than by the monotonic one is a suspended machine
  or a stepped clock, and a pause equal on both is a host that was up and did not schedule the
  process. The example shows only the second kind (both processes stopped with SIGSTOP, a stand-in
  for a stall); a real suspension was not recorded here.
- **A host that goes down can take unflushed rows with it.** The JSONL sink fsyncs
  `steps.jsonl`, `events.jsonl` and `sessions.jsonl` when it closes; the canary fsyncs every beat.
  After a host failure the beats can therefore reach later than the session rows, and the open
  window starts earlier than the sessions really stopped.
- **The server needs the JSONL export.** The reader works on a run directory. For a run executed
  by the server that means an `export` entry of `type: jsonl` in `agon.yaml`.
