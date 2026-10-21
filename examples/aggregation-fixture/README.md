# Aggregation fixture: merging partial results without losing the denominator

Agon analyzes a run's sessions in one pass, but results also get combined after the fact: per
persona, per model, per shard of a long run, per re-analysis of a slice. A metric that not every
session has a value for (a `duration` nobody reached, a judge score nobody gave) makes that merge
easy to get subtly wrong. This fixture is a small dataset plus a test that pins the right answer.

The design is excelsior's, from a conversation on Moltbook:

> The test should merge the same disjoint rows through several partitionings and get the same
> result and exclusion counts each time. An all-excluded partition should contribute zero valid
> weight, not a zero-valued observation.

A partial result here carries three markers per version (in Agon, the version is the variant):
`sum`, `valid_n` and `missing_in_version`, the number of that version's sessions with no value
for the metric. A merge adds all three. The merged mean is merged `sum` over merged `valid_n`,
and nothing else. The fixture is built to fail a combiner that keeps the markers but does not use
them as denominators.

## Files

| file | what it is |
|---|---|
| `sessions.jsonl` | 200 sessions, two variants, in the subset of the `@agon/spec` Session shape agon-stats reads. One `duration` metric, `seconds_to_first_project`, that some sessions never recorded. |
| `make_sessions.py` | Writes `sessions.jsonl`. No randomness; the docstring lists every block of rows. A test checks the committed file still matches it. |
| `analysis.json` | The `agon-stats analyze` config for the run (two metrics, `stratifyBy: ["persona"]`). |
| `test_merge_partitions.py` | The fixture's test, runnable under pytest or as a script that prints the table below. |

## Run it

From the repository root (the stats package's environment supplies `agon_stats`):

```sh
uv run --project packages/stats pytest examples/aggregation-fixture
uv run --project packages/stats python examples/aggregation-fixture/test_merge_partitions.py
```

The script prints, for every partitioning, the merged `sum`, `valid_n`, `missing` and mean per
version, next to what a mean of partition means gives when an all-excluded partition counts as a
zero:

```
partitioning   sizes                    version         sum  valid_n  missing     mean  mean of means
whole          200                      control        4800       80       20    60.00          60.00
whole          200                      treatment      3640       91        9    40.00          40.00
persona        61/128/11                control        4800       80       20    60.00          40.00
persona        61/128/11                treatment      3640       91        9    40.00         323.33
model          11/189                   control        4800       80       20    60.00          57.63
model          11/189                   treatment      3640       91        9    40.00          35.23
file order     1/9/140/50               control        4800       80       20    60.00          57.04
file order     1/9/140/50               treatment      3640       91        9    40.00          41.10
has a value    171/29                   control        4800       80       20    60.00          30.00
has a value    171/29                   treatment      3640       91        9    40.00          20.00
id hash        31/38/28/26/24/26/27     control        4800       80       20    60.00          60.58
id hash        31/38/28/26/24/26/27     treatment      3640       91        9    40.00          40.82
```

The same `agon-stats analyze` run on the whole file is one command away, and its warnings carry
the exclusion counts in words:

```sh
cd packages/stats && uv run agon-stats analyze \
  --sessions ../../examples/aggregation-fixture/sessions.jsonl \
  --config ../../examples/aggregation-fixture/analysis.json
```

## The data

Per variant, 100 sessions. The partition sizes are lopsided on purpose.

| variant | persona | sessions | `seconds_to_first_project` |
|---|---|---|---|
| control | smb-owner | 60 | 50 valid, alternating 50 and 70 (mean 60); 10 without a value |
| control | developer-evaluator | 30 | 30 valid, alternating 50 and 70 |
| control | skeptical-cfo | 10 | none has a value: an all-excluded partition |
| treatment | developer-evaluator | 98 | 90 valid, alternating 20 and 40 (mean 30); 8 without a value |
| treatment | smb-owner | 1 | one value, 940 |
| treatment | skeptical-cfo | 1 | no value |

Truth: control sums to 4800 over 80 valid sessions, mean 60, with 20 excluded; treatment sums to
3640 over 91, mean 40, with 9 excluded. Every 19th session in file order runs on the second
model (11 of 200), which is the `model` partitioning.

## What the test asserts

1. **Every partitioning merges to the same result.** Six partitionings (the whole file; persona;
   model; file-order chunks of 1, 9, 140 and 50 rows; whether the session has a value; a hash of
   the session id) all give the same `sum`, `valid_n` and `missing_in_version` per version, and a
   mean of 60 and 40 that is `sum / valid_n`.
2. **The exclusion counts are identical across partitionings**: 20 and 9 every time.
3. **An all-excluded partition contributes zero valid weight.** The `skeptical-cfo` partition is
   `sum 0, valid_n 0, missing 10` for control; its mean is undefined, not `0.0`. A combiner that
   turns it into one zero-valued observation reaches `valid_n` 81 and a mean of 59.26 while still
   reporting the right exclusion count of 20, which is exactly the failure excelsior described: the
   marker fields survive and the denominator lies.
4. **A mean of partition means is caught.** Treatment by persona gives 485 with the empty persona
   skipped and 323.3 with it zero-filled, against 40 from the merge. Control is the trap: every
   persona's valid values average 60, so the naive mean is right by luck until the empty
   persona is zero-filled, which drops it to 40. Under the `has a value` partitioning the naive mean
   that skips empty partitions is right by luck too, and only the zero-filled one fails. The test
   requires that at least one of the two naive combiners is wrong under every partitioning but the
   whole file.
5. **agon-stats agrees.** On the whole file `analyze_sessions` reports `sessions` 80 and 91
   (sessions with a value, not all 100) and means 60 and 40, and its warning reads
   `control: 20 of 100 sessions have no value for seconds_to_first_project; excluded`. Run per
   persona, the three `VariantStats` merge back to the whole when the sum is rebuilt as
   `mean * sessions`; the all-excluded persona comes out as `sessions 0, mean 0.0`, which is zero
   weight when weighted by `sessions` and a spurious zero if read as an observation.

## What the engine carries today

Two things the fixture had to work around are worth knowing when combining `Result` documents:

- `VariantStats` has `sessions` (the valid count) and `mean`, so the sum is recoverable, but the
  excluded count is not a field. It appears only in the metric's `warnings` as a sentence, which
  `partial_from_variant_stats` parses with a regular expression.
- The per-stratum report (`stratification.strata`) is computed over the sessions that have a value,
  so a stratum with no valid session in either arm does not appear at all; `skeptical-cfo` is absent
  from the strata of this run while its exclusions are counted in the warnings.
