# A capped run, as the JSONL sink recorded it

`run_ozsunqg7j34l56uj/` holds the `run.json` and `sessions.jsonl` of a real local run that hit its
time cap: ten sessions planned over two variants, five reached an outcome (four passed, one gave
up), five were interrupted. It is the fixture behind the per-variant report in
[docs/run-termination.md](../../docs/run-termination.md#reading-the-per-variant-counts):

```sh
node scripts/run-report.mjs examples/run-report
```

```
run_ozsunqg7j34l56uj completed: time_cap_reached after 2.4s (cap 2000 ms) · 5/10 sessions reached an outcome

variant    sessions                             pass rate          planned-set rate  interrupted  not started  did not pass
control    1 passed / 2 completed / 5 planned   50% of completed   20%–80% (open)    3            0            1
treatment  3 passed / 3 completed / 5 planned   100% of completed  60%–100% (open)   2            0            0
all        4 passed / 5 completed / 10 planned  80% of completed   40%–90% (open)    5            0            1
```

For comparison, `agon run` itself summarized the same run as `control 5 20%` and
`treatment 5 60%`: its `sessions` column counts interrupted sessions and its `success` column
divides by them, so the cap reads as a product failure. The report above is the reading
excelsior asked for in a Moltbook thread on time caps: "print `4 passed / 5 completed / 10 planned`,
label 80% as conditional on completion, and keep per-variant interruption counts visible."

## How the fixture was produced

The run used the engine's offline fakes (`@agon/engine/fakes`: `FakeLlm(happyUser)` against
`ledgerlySite`) through the CLI's `runCommand`, with a 2000 ms time cap and concurrency 10, on the
`ledgerly-fixture` config whose snapshot sits in `run.json`. The fake adapter was slowed so that
session `i` waited `40 + 60 × i` ms per step, which put the five slowest sessions past the cap, and
session 1 was given a page on which nothing works, so its eager user ran out of patience and gave
up. Nothing in the records was edited except the export path in
`termination.partialDeltaManifest.exportsWritten`, shortened from a temporary directory to
`./agon-out`, and the whitespace of `run.json`, which prettier reflowed.

`steps.jsonl`, `events.jsonl` and `manifest.json` are omitted; the report reads only `run.json` and
`sessions.jsonl`. `agon trace` and `agon compare` need the full directory and are not meant to run
on this one.
