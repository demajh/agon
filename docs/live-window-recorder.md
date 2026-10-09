# The live-window recorder

Everything Agon computes before a release is a **model**: simulated users, calibrated forecasts,
a rehearsal of what real traffic might do. The first hours after a release are the
**measurement** that every one of those models is later checked against. The live-window recorder
fixes what is recorded in that window, and gives it a gate: did the system start moving between
states in a way the pre-release baseline says it should not?

## What is recorded

Four series, aligned at one grain. `grainMs` is the length of every interval, and sample `i` of
every series covers the same interval.

| series | what | in |
|---|---|---|
| `latencyMs` | latency per interval, p50 or mean (the same statistic in both windows) | ms |
| `retryRate` | retries per request in the interval | [0, 1] |
| `abandonmentRate` | abandoned requests or sessions per started one | [0, 1] |
| `queueDepth` | depth of the queue where supply meets demand, sampled at the end of the interval | items |

Each window also carries a `capacity` label, such as `"4 replicas"`. The baseline and the live
window must carry the same label and the same grain, or the gate refuses to compare them.

### Why queue depth

Latency, retries and abandonment are symptoms, each seen from one side. Queue depth is where
supply (the service rate the capacity allows) and demand (arrivals, retries included) meet: it
grows exactly when demand outruns supply, and it is the stock that carries a disturbance from one
interval to the next. A retry storm is a loop through that stock. Latency rises, clients time out
and retry, the retries add demand, the queue grows, and latency rises further. Without the queue
the gate would see the symptoms move but not the state variable that links them. With it, the
loop shows up as a sequence of states the system keeps cycling through.

## Model versus measurement

Every analysis result carries a `kind`. `model` is anything computed before the release from
simulated sessions: every `agon-stats analyze` result, with an `assumptions` list saying what the
forecast takes for granted. `measurement` is an observation of the live window: the
`LiveWindowReport` this gate writes is always `kind: measurement`.

The boundary is about what can be wrong. A model can be wrong in its assumptions: the personas,
the scenarios, the calibration. A measurement can be wrong only in its instruments. Agon keeps the
two in separate types (`Result` and `LiveWindowReport`) and labels both, so that a forecast and an
observation never sit unlabelled in the same column. The live window is what a model's
calibration is eventually scored against.

## The input format

Agon does not capture live traffic itself. Export the four series from your metrics system (one
query per series, with a step equal to `grainMs`) into this JSON, once for the baseline and once
for the live window. The format is `LiveWindowSchema` in `@agon/spec`:

```json
{
  "capacity": "4 replicas",
  "grainMs": 10000,
  "startedAt": "2026-10-09T14:00:00.000Z",
  "series": {
    "latencyMs": [112, 118, 109, 121],
    "retryRate": [0.01, 0.012, 0.009, 0.011],
    "abandonmentRate": [0.02, 0.019, 0.021, 0.02],
    "queueDepth": [3, 4, 3, 5]
  }
}
```

The series must be aligned (equal lengths, at least two samples), finite and non-negative; the
rates must lie in [0, 1] and `grainMs` must be a positive integer. `startedAt` is optional.

```sh
agon live-window --baseline baseline.json --live live.json            # exit 0 passed, 2 fired, 3 too little data, 1 error
agon-stats live-window --baseline baseline.json --live live.json --out report.json
```

Optional flags on both: `--percentile 95`, `--min-transitions 20`, `--decompose-above 0.25`,
`--bootstrap-samples 1000`, `--seed 0`, and `--buckets <file>` for declared bucket edges
(`LiveWindowBucketsSchema`). From TypeScript, `liveWindowGate()` in `@agon/stats-client` returns
the validated report.

## The bootstrap baseline

The baseline is a pre-release window at matched capacity, for example the hours before the
release at the same replica count, or a load test at the same capacity. Its states are resampled
with a moving-block bootstrap over its transitions (consecutive state pairs, in blocks of about
√n transitions, so no transition is invented where two blocks meet). This gives
`bootstrapSamples` replicate transition matrices: a distribution for every transition
probability, not a single estimate. The live window is bootstrapped the same way for the
live-side bounds, because bucketed operational series are autocorrelated: transitions out of a
band come in runs, and treating them as independent draws makes every bound too narrow.
Everything is seeded (numpy `default_rng`), so a report is reproducible from its parameters.

## States: coarse first, then decompose

Each series is cut into bands of the **baseline's** distribution. The coarse cut is at the 90th
percentile (`..p90`, `p90..`); the fine cuts are at the 50th, 90th and 99th (`..p50`, `p50..p90`,
`p90..p99`, `p99..`). A state is one band per series, for example
`latencyMs=p90..|retryRate=..p90|abandonmentRate=..p90|queueDepth=..p90`. A value equal to an edge
falls in the lower band. The quantiles of a flat series coincide, so they collapse into one edge,
named after the largest of them. Declared edges (`--buckets`) replace the quantiles; their fine
edges must contain every coarse edge.

Granularity is hierarchical. Every window is first expressed in coarse states, and only the
coarse states (clusters) whose share of the live transitions exceeds `decomposeAbove` are
decomposed into fine states. Because the fine edges refine the coarse ones, a decomposed state
stays inside its cluster. The rule refines where the data is and keeps sparse regions coarse,
because a fine state reached a handful of times cannot support a transition estimate.

## The gate and its direction

The question for each state: did a transition that was improbable before the release become the
most likely successor of that state now? A state `from` fires a signal `from -> to` when all
three hold:

1. **Support.** At least `minTransitions` (default 20) live transitions leave `from`.
2. **A decisive successor.** `to` is the most likely live successor of `from`, and the live
   bootstrap lower bound of its margin over the runner-up is above zero.
3. **Improbable in the baseline.** `to` was not the baseline's most likely successor of `from`,
   and the live lower bound of P(`from -> to`) exceeds the `percentile`-th percentile (default
   95) of the bootstrap distribution of the baseline's P(`from -> to`). A state the baseline never
   left has no baseline probability, so every transition out of it counts as improbable; support
   and decisiveness still apply.

The live-side bounds are **family-wise** across the states tested (Bonferroni: each state is held
to `(100 - percentile) / statesTested`, reported as `gate.liveLevel`), so a richer state space does
not raise the chance that one of its states fires on noise. The baseline percentile is used as
given, because it is the definition of "improbable in the baseline".

The first two guards exist because of a false alarm. A stationary window, decomposed into fine
states, gave some states a few dozen transitions spread over twenty successors. The largest cell
of such a row is noise, and an early version of the gate fired on it. The support and
decisiveness rules, and the family-wise level, are the fix.

The signal is **a direction, not a scalar distance**. A distance between two matrices says that
something changed. A signal says what changed: from a state where latency was up and retries
normal, the system now goes to one where retries are up too, where before the release it went
back to normal. Each signal reports `from`, `to`, the per-series labels of both, the live share
and its lower bound, the runner-up's share, the margin's lower bound, the baseline's percentile
value and median, the transition counts on both sides, and `baselineSuccessor`, what the state
did before the release. A retry storm shows up as the edges of its loop.

`gate.status` is `passed` (states were tested and none fired), `fired`, or `insufficient` (no state
had `minTransitions` live transitions, so nothing was judged). An insufficient window is not a
pass, so record a longer one.

### How it holds up

Measured with the generators in `packages/stats/tests/test_transitions.py` at the default
parameters, on seeds the tests do not use. On 400 pairs of stationary windows (independent noise
and autocorrelated AR(1) noise with φ = 0.8, at 600 and 3000 samples, 100 pairs each), the gate
fired 3 times (0.75%), against a nominal family-wise rate of 5%. On 50 windows with an injected
retry-storm loop (200 calm samples, then 40 cycles of latency up, retries up, queue up), it fired
50 times, each time on exactly the loop's three edges. The tests pin both behaviours: stationary
windows pass, the storm fires in the loop's direction, sparse and thin rows never fire, and
decomposition happens only where the live mass is concentrated.

## What Agon does not do yet

- **Capture.** Agon records nothing from live traffic. The two windows are files you export from
  your own metrics system, in the format above.
- **Act.** A fired gate is a report and an exit code. Nothing in Agon rolls back, pauses a squad
  or files a finding on its own; wire the exit code into the pipeline that owns the release.
- **Store.** The server has no route for live-window reports, and they are not saved next to
  results.
- **Verify capacity.** Capacity is matched by label. Agon cannot check that "4 replicas" meant
  the same thing in both windows.
- **See beyond the most likely successor.** The gate tests one transition per state. A shift in
  the second most likely transition, or a slow drift that never changes the winner, is not
  reported.
