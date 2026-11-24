# Stall canaries: two no-op sibling writers beside a run

A run that goes quiet does not say why. Its sessions stop appending rows, and the record that
eventually lands is the same whichever of three things happened: the host froze, the disk or the
network path the sessions share stopped answering, or the sessions themselves are stuck. Agon's
own signals do not separate them. The `stalled` session outcome (`stallSteps` in a scenario) counts
steps without progress, so it needs steps to keep arriving; the per-session timeout and the run's
time cap ([run-termination.md](run-termination.md)) fire on the clock and record
`counts.interrupted`, with no cause attached.

nim proposed the instrument on Moltbook, answering whether a heartbeat should be a bare beat or
should exercise the path the work uses:

> both, as two canaries: a pure beat that only proves the host is breathing, and a tiny one that
> writes a byte to the same disk and opens the same socket.

This page describes that design against Agon as it is, and
[`examples/stall-canaries/`](../examples/stall-canaries/) runs it. Nothing in `packages/` emits a
canary beat or a stall verdict today: the example is a sidecar that runs beside `agon run`, and the
run record is unchanged by it.

## The two canaries

Both are siblings of the real writers: separate processes on the same host, started with the run
and stopped with it, doing no work of their own.

| canary | each interval it | a beat proves |
|---|---|---|
| pure | sends a sequence number to its supervisor and nothing else: no file, no network socket | the host schedules processes |
| path | writes one byte into the directory the run writes to and fsyncs it, opens a TCP connection to the address the run talks to and closes it without sending; beats only when both legs finished | the host schedules processes, and that disk and that route accept a write and a connection |

What "the same disk" and "the same socket" mean for a local run:

- **Disk.** `agon run` writes `<out>/<runId>/` through the JSONL sink (`--out`, `$AGON_OUT_DIR`,
  default `./agon-out`): `sessions.jsonl`, `steps.jsonl` and `events.jsonl` are appended to as
  sessions proceed. The path canary writes its byte to `<out>/.agon-path-canary`, on the same
  filesystem. `agon trace` and the report scripts look under the output directory only for
  entries that hold a `run.json`, so the file is not mistaken for a run, and the sidecar removes
  it when it stops.
- **Socket.** The adapter connects to the variant's `url` and the model client to its provider.
  The path canary takes one `host:port`; point it at whichever the sessions cannot proceed without.
  It connects and hangs up, so the target sees an opened and closed connection and no request.

The pure canary must not borrow the path it is the control for. In the example its beat travels
over the channel `child_process.fork` gives parent and child, which is local to the host. A "pure"
beat appended to a file on the run's disk would be a second path canary.

A run executes in one process: `agon run` locally, or the server process that took the job from
the queue. So there is one host per run today and one pair of canaries per run. With several hosts
the pair is per host and each host is read by itself; the fixture has a three-host case.

## The verdict

A source is **silent** when its last beat is older than the silence threshold (or, having never
beaten, when observation began longer ago than that). nim's reading is the first two rows; the
other three are what the remaining combinations have to mean once the first two are fixed.

| pure canary | path canary | real writers | verdict | reading |
|---|---|---|---|---|
| silent | silent | any | `host_stalled` | the host is not breathing; nothing on it can be blamed separately |
| beats | silent | any | `shared_path` | the host runs and the shared disk or network path does not; `leg` names which |
| beats | beats | silent | `writers` | a sibling just wrote to that disk and opened that socket, so the silence belongs to the writers: the product under test, the model provider, or a stuck session |
| beats | beats | writing, or not observed | `healthy` | |
| silent | beats | any | `canary_fault` | the path canary beat on this host, so the host runs; the pure canary itself is gone, and the instrument is broken rather than the run |

The path canary reports every attempt with the state of each leg (`ok`, `failed`, `timeout`), and
only an attempt with both legs `ok` is a beat. So `shared_path` carries `leg: disk | socket | both`
from the latest failed attempt, or `unknown` when the canary has reported nothing at all since its
last beat. Each leg runs under its own timeout (half the silence threshold, never less than one interval), so a write that hangs
rather than fails is still reported as `timeout`, as long as the canary's own process keeps running.

The real writers are observed from outside, as a change in the files under the run's directory
(count, sizes, modification times). A run that is waiting on a slow model call for longer than the
threshold reads as `writers`, which is accurate: neither the host nor the path is holding it up.

### The reader stalls with the host

A supervisor on the same host is frozen along with the canaries it reads, so at the moment of a
real host stall nobody computes `host_stalled`. The supervisor therefore beats too: when its own
timer fires later than the threshold, it reports `host_stalled` for the missing interval and starts
observing afresh, because beats from before the freeze prove nothing about now. A reader that must
see a host stall while it is happening has to live on another host, and reaching it crosses a
network path that then needs the same two-canary treatment.

## Running it

The example needs only Node 22 or later and no build.

```sh
node examples/stall-canaries/canaries.mjs replay
```

reads `cases.jsonl` (twelve host observations: last-beat times for the three sources, the path
canary's latest attempt, the threshold and the expected verdict) through the reader and exits 1
when one differs:

```
ok   three hosts, one frozen      host-a   healthy
ok   three hosts, one frozen      host-b   host_stalled
ok   three hosts, one frozen      host-c   healthy
ok   target refuses connections   host-a   shared_path (socket)
ok   disk full                    host-a   shared_path (disk)
ok   network mount hangs          host-a   shared_path (both)
ok   path canary wedged           host-a   shared_path (unknown)
ok   writers stuck, path fine     host-a   writers
ok   writers not observed         host-a   healthy
ok   pure canary died             host-a   canary_fault
ok   just started                 host-a   healthy
ok   never beat                   host-a   host_stalled
12/12 cases read as written
```

```sh
node examples/stall-canaries/canaries.mjs demo
```

does it live on the machine it runs on: a temporary directory, a local TCP listener standing in for
the target, a stand-in writer appending rows to `sessions.jsonl` in that directory, and the two
canaries. It then closes the listener, reopens it, freezes all three processes with `SIGSTOP`,
resumes them, freezes the writer alone, and kills the pure canary, checking the verdict after each
(about ten seconds; POSIX only):

```
ok   everything runs                          healthy
     canaries and writers all beat
ok   the target stops accepting connections   shared_path (socket)
     the host beats and the path canary cannot finish: socket failed
ok   the target is back                       healthy
     canaries and writers all beat
ok   canaries and writer frozen (SIGSTOP)     host_stalled
     neither canary beats: the host is not breathing
ok   resumed (SIGCONT)                        healthy
     canaries and writers all beat
ok   the writer alone frozen                  writers
     both canaries beat on the same disk and socket: the silence is in the writers
ok   the pure canary killed                   canary_fault
     the path canary beats on this host, so the host runs; the pure canary itself is gone
```

The freeze stops processes, not the machine, which is why the supervisor stays awake to read it;
the disk leg is covered by the fixture and not by the demo, which has no safe way to break a disk.

### Beside a run

```sh
node examples/stall-canaries/canaries.mjs watch --dir ./agon-out --connect localhost:3001 \
  -- pnpm agon run agon.yaml --json > run.json
```

`watch` starts both canaries, runs the command after `--` with its stdin, stdout and stderr
untouched, and exits with the command's exit code, so the mapping in
[run-termination.md](run-termination.md#exit-codes-of-agon-run) still applies. `--dir` is the run's
output directory and `--connect` the `host:port` its sessions depend on (here the demo app's
control variant). Everything the sidecar prints goes to stderr: one line each time the verdict
changes, and a summary of the time spent under each verdict when the command ends (`--json` for
the summary as one JSON line with the changes and their offsets).

```
canaries build-7 +2.2s writers: both canaries beat on the same disk and socket: the silence is in the writers
canaries build-7 +3.6s healthy: canaries and writers all beat
canaries build-7 observed 4.7s: healthy 3.3s, writers 1.4s
```

`--interval-ms` (default 1000) is the beat period and `--silence-ms` (default 5000, at least twice
the interval) the threshold. The lines above come from a stand-in command that appended rows to a
file under `--dir` and paused for two seconds, with a 200 ms interval and a 1000 ms threshold; the
host name is replaced.

## What the verdict is for

The summary answers the question the run record leaves open when a cap or a timeout cut sessions.
`time_cap_reached` with `counts.interrupted > 0` is a neutral result when the sessions were slow,
and a pipeline problem when the host or the path was the reason they were slow; the two look the
same in `termination`. Read beside it:

- seconds under `host_stalled` or `shared_path` are time the cap counted and the product did not
  have. A capped run that spent a large share of its cap there measured the infrastructure, and the
  interrupted sessions say nothing about the variants.
- seconds under `writers` with both canaries beating are the run's own: the target, the model
  provider or the sessions were slow on a host and a path that worked.
- `canary_fault` means the instrument failed and the other figures for that stretch are not
  evidence either way.

The sidecar does not change `termination.kind`, exit codes or any session row, and `agon run` does
not know it is there. The canaries prove one directory and one address. A second disk, a second
endpoint or a name lookup that only the real writers perform is outside what a `path` beat shows.
