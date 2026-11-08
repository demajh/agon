# Rates that carry their eligible rows

The rate row described in [docs/results-contract.md](../../docs/results-contract.md#rates-carry-their-eligible-rows):
every per-variant rate keeps its numerator apart from four counts (raw, ineligible by reason,
eligible, measured), prints as undefined rather than `0.00` when nothing eligible was measured, and
is refused by a reader whose eligible count is missing or zero. The design point is RushantsBro's,
from a conversation on Moltbook:

> Does your results contract require a denominator to declare how many of its rows were eligible,
> or only how the numerator was read?

| file | what it is |
| --- | --- |
| `sessions.jsonl` | 16 sessions in the shape agon-stats reads: `control` (6, three activated with a duration), `treatment` (6 finished, none activated, so no duration), `redesign` (4 that never reached an outcome) |
| `analysis.json` | the `agon-stats analyze` config: `activation` (conversion, primary) and `seconds_to_first_project` (duration) |
| `today.py` | runs agon-stats' `build_result` on the sessions and prints each variant's statistic beside the denominator the contract asks for |
| `rate-rows.jsonl` | ten rate rows, the set each is stamped with, and the grade and printed value the reader must produce |
| `rate-gate.mjs` | the reader's registry (`example.rate_row.1`), the writer-side stamp check, the gate plus rate check, a merge, and the runner |

## What agon-stats reports today

```
uv run --project packages/stats python examples/eligible-denominator/today.py
```

```
metric                     variant    agon-stats today                   raw inelig elig meas  contract
activation                 control    sessions=6 mean=0.50                 6      0    6    6  0.50
activation                 treatment  sessions=6 mean=0.00                 6      0    6    6  0.00
activation                 redesign   absent from the result               4      4    0    0  undefined (0 eligible: 4 no_outcome)
seconds_to_first_project   control    sessions=3 mean=50.00                6      0    6    3  50.00
seconds_to_first_project   treatment  sessions=0 mean=0.00                 6      0    6    0  undefined (0 of 6 eligible measured)
seconds_to_first_project   redesign   absent from the result               4      4    0    0  undefined (0 eligible: 4 no_outcome)
```

followed by the comparisons and warnings the Result carries and five checks. The script exits 1
if agon-stats stops reporting what this page says it reports.

- **Two `mean=0.00` rows, one of them a zero.** `activation` for `treatment` is a real 0 of 6.
  `seconds_to_first_project` for `treatment` is a mean over no sessions: `ci95` is `[0, 0]` and the
  comparison prints a lift of −100%, which for a duration (lower is better) reads as the treatment
  taking no time at all. Only the warning `treatment: 6 of 6 sessions have no value for
  seconds_to_first_project; excluded` says otherwise.
- **`redesign` is not in the result at all.** Its four sessions have no outcome and are dropped
  before analysis. The Result keeps one warning, on `scenario_success`, that says four sessions
  were excluded, not from which variant.
- **The control's duration has three unmeasured rows** (the sessions that never activated). Under
  the contract they are counted. Agon cannot say today whether a missing duration means the step
  was never reached (ineligible) or the value was lost (eligible, unmeasured), so this script
  counts every finished session as eligible and the missing values as unmeasured.

## The reader gate

```
pnpm build
node examples/eligible-denominator/rate-gate.mjs
```

The script imports `@agon/spec` and `@agon/exporters` from their built `dist/` by path, so it is
not a workspace package and needs no install of its own. It exits 1 when a grade or a printed
value differs from `rate-rows.jsonl`, when the writer stamps a row with no eligible count, or when
the merge comes out wrong.

```
case   gate                        grade                       printed                                 missing
r_01   ok                          RATE_DEFINED                0.50                                    -
r_02   ok                          RATE_DEFINED                0.00                                    -
r_03   ok                          RATE_ELIGIBLE_ZERO          undefined (0 eligible: 6 no_outcome)    -
r_04   ok                          RATE_UNMEASURED             undefined (0 of 6 eligible measured)    -
r_05   ok                          RATE_DEFINED                0.40 (1 eligible not measured)          -
r_06   ok                          RATE_ELIGIBLE_MISSING       refused                                 -
r_07   REQUIRED_SET_NOT_SUPERSET   REQUIRED_SET_NOT_SUPERSET   refused                                 denominator.ineligible, denominator.eligible, denominator.measured
r_08   ok                          RATE_COUNTS_INCONSISTENT    refused                                 -
r_09   ok                          RATE_REASON_MISSING         refused                                 -
r_10   ok                          RATE_COUNTS_INCONSISTENT    refused                                 -

served as a rate:        3 (r_01, r_02, r_05)
no eligible count refused at stamp: 1/1
merged shards:           0.50 (mean of shard rates, empty shard as 0: 0.33)
merged empty shards:     undefined (0 eligible: 6 no_outcome)
grades as written:       10/10
```

## What the cases show

- **r_02 and r_03 are the point.** Both have numerator 0 and raw denominator 6. A contract that
  records only how the numerator was read cannot tell them apart. With `eligible` carried, r_02 is
  a zero and r_03 is not a number.
- **r_04: eligible but never read.** Six sessions the metric applies to, no value recorded for any.
  Undefined, and printed with the count, so "nobody converted" and "nothing was recorded" never
  share a line.
- **r_05: a gap that does not void the rate.** One eligible session was not measured. The value is
  served, and the gap is printed next to it.
- **r_06: presence is not enough.** `eligible: null` passes the stamp, because a nullable column
  counts as present (see the contract's stamp rules), so the rate check refuses it separately.
- **r_07: the numerator-only contract is refused at the gate.** Its rows are complete for the
  producer's own set and miss the three counts the reader relies on, which the gate names.
- **r_08 to r_10: counts that do not add up are refused**, and an ineligible count with no reason
  is refused on its own code, because "ineligible" without a reason is an exclusion nobody can audit.
- **The merge.** Three shards of one variant, one with every session unfinished, merge by adding
  the counts to `3 / 6 = 0.50`. Averaging the shard rates with the empty one as zero gives `0.33`.
  Two empty shards merge to an empty denominator, still undefined.

The `RATE_*` grades are this example's, not gate codes. The gate grades shape; the counts are
checked after it, on every row that passed.
