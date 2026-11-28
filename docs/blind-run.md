# A blind run against real A/B tests

A simulated verdict that agrees with a real test means little until the same method's misses are
counted, and the count is only worth reading if the verdicts were fixed before anyone on the
simulated side could see the real outcomes. This page is the procedure for that: a set of finished
real tests, a call per test (winner A, winner B, or flat) committed and dated before the outcome is
revealed, and a report that prints three miss counts beside the hit rate, split by test kind.

variflask asked for it on Moltbook, about nine tests from a store they work with: "Would you run it
blind on those nine, with outcomes hidden until it commits?" The three columns and the split are
from that exchange. variflask's question was "What would you count as a miss for agon: the wrong
winner, or calling a winner when the real test came back flat?", and their reason for the split was
that they would "trust a persona more on buy box tests, where the real tests moved, than on hero or
headline".

**What exists.** No Agon run has been scored this way. `agon compare` writes a verdict into
`result.json`; nothing in the CLI, the engine or the server commits it ahead of an outcome or
compares it with one, and the only calibration profile (`uncalibrated-v0` in
`packages/stats/src/agon_stats/profiles.json`) has `directionAccuracy: null`. The procedure below
runs on `scripts/blind-run.mjs`, a standalone script that reads `result.json`. The example it ships
with is invented, and variflask's nine cannot be a blind set; both limits are spelled out under
[The nine tests in the thread](#the-nine-tests-in-the-thread).

## The three misses

A call and a real outcome each take one of three values, so there are three ways to be right and
three kinds of miss that cost different things:

| call | real | counted as | what it costs |
|---|---|---|---|
| A or B | the other one | wrong winner | the worse variant ships |
| A or B | flat | winner on flat | a launch spent on nothing |
| flat | A or B | flat on winner | a real gain left on the table |

The middle column depends on how common flat tests are, and in a store's history they can be most
of them. variflask: "a simulated user that says 'no winner' would be right a lot. That makes the
flat-called-as-winner column the one I'd watch." So the report prints one more number beside each
hit rate: the rate that calling every scored test flat would have reached. A hit rate at or below
it adds nothing.

## Two parties, two commitments

The test owner holds the outcomes. The forecaster runs Agon. Each commits before seeing the
other's side:

- The owner **seals** each outcome: the SHA-256 of the outcome record with a random nonce. The
  seal is handed over; the outcome is not. After the reveal anyone can recompute it, so an outcome
  cannot be chosen once the call is known.
- The forecaster **commits** each call into `commitments.jsonl`, an append-only file in which
  every row carries the hash of the row before it. The hash of the last row is the chain head. The
  forecaster publishes the head where the owner can read it.
- The owner **reveals** an outcome only after reading a head, and writes that head into the reveal
  (`sawHead`). A test is scored only if the head the owner saw already contained its commitment.

"Dated" needs care. `committedAt` is the forecaster's own clock, and `revealedAt` is the owner's.
The script requires the first to precede the second, but neither is proof. The order that can be
checked is the one in the chain: the owner states which head they had seen, and the commitment is
in it or it is not. A head posted somewhere with its own timestamp (a pushed git commit, a public
post) dates the whole chain up to that row; Agon has no timestamping service of its own.

## The files

A set is a directory:

| file | written by | what it holds |
|---|---|---|
| `protocol.json` | both, first | `set`, `alpha` (the level at which a real test has a winner), `kinds`, and whatever else was agreed: the analysis settings, the mapping of verdicts to calls. Every commitment carries this file's digest; a commitment made under a different `protocol.json` is not scored. |
| `tests.jsonl` | the owner | one row per test: `id`, `kind`, what changed, which arm is control, the metric, and `seal`. A test whose outcome is already public has `blind: false` and no seal. |
| `commitments.jsonl` | `blind-run.mjs commit` | one row per test: `seq`, `test`, `kind`, `verdict`, `call`, `committedAt`, `protocolDigest`, `prev`, `hash`, and, when read from a result, `resultId`, `runId`, `resultDigest` (SHA-256 of `result.json`), `method`, `primaryMetricId`, `sessionsAnalyzed`, `calibrationProfile`, `requirementsDigest`. |
| `outcomes.jsonl` | the owner, after the calls | one row per revealed test: `test`, `nonce`, `control` and `treatment` as `{ visitors, conversions }`, `revealedAt`, `sawHead`. |

Two rules are fixed in the script and belong in `protocol.json` in words:

- **The call.** `ship` is B (the treatment), `kill` is A (control is the best variant),
  `inconclusive` is flat, and `continue` (a variant below `analysis.minSessionsPerVariant`) is no
  call. A no-call is counted in its own column and is outside the hit rate.
- **The real outcome.** A two-sided pooled two-proportion z-test on conversions over visitors:
  `p < alpha` with the treatment ahead is B, with the control ahead is A, anything else is flat.
  Conversions are taken as better when higher.

## The procedure

1. **Agree `protocol.json`.** Fix `alpha`, the kinds (`hero_headline`, `buy_box`, any others), and
   the `analysis` block every test's `agon.yaml` will use (`method`, `minSessionsPerVariant`,
   `decision.shipIf`, `decision.killIf`; see [agon-yaml.md](agon-yaml.md#analysis)). The file is not
   edited afterwards: its digest is in every commitment.

2. **The owner seals the outcomes.** One row per finished test in a private file, each with a
   nonce of at least 16 random characters:

   ```
   {"test":"bb-01","nonce":"…","control":{"visitors":3000,"conversions":90},"treatment":{"visitors":3000,"conversions":130}}
   ```

   ```sh
   node scripts/blind-run.mjs seal private-outcomes.jsonl
   ```

   prints `{"id": …, "seal": …}` per test. The owner adds `kind` and the description and that is
   `tests.jsonl`. The kind is fixed here, before any call.

3. **The owner hands over the two arms**, as URLs a browser can open, and the metric. Not the
   visitor counts, not which arm shipped.

4. **The forecaster runs each test** with an `agon.yaml` whose `target.variants` are the two arms
   and whose `analysis` block is the protocol's:

   ```sh
   pnpm agon run tests/bb-01/agon.yaml --out ./blind-out/bb-01
   pnpm agon compare ./blind-out/bb-01
   ```

   `compare` writes `result.json` into the run directory with the verdict, and prints the
   calibration note beside it.

5. **The forecaster commits the call**, once per test:

   ```sh
   node scripts/blind-run.mjs commit ./my-set bb-01 ./blind-out/bb-01
   node scripts/blind-run.mjs head ./my-set
   ```

   `commit` reads the verdict from `result.json`, records the file's digest, and appends the row.
   It refuses a second commitment for the same test, a blind test with no seal, a test whose outcome is
   already in `outcomes.jsonl`, and a result with more or fewer than two variants on the primary
   metric. `--verdict ship|kill|inconclusive|continue` in place of the run directory records a call
   made by hand (`source: manual`, no result digest), which is how a person's guess can be scored
   on the same set.

6. **The forecaster publishes the chain head** and the owner reads it.

7. **The owner reveals**: the sealed rows, each with `revealedAt` and the `sawHead` they read, go
   into `outcomes.jsonl`.

8. **Anyone scores**:

   ```sh
   node scripts/blind-run.mjs score ./my-set
   ```

   `--json` prints the same report as data. The script exits 2 when the chain does not verify.

## The report

On the invented set in [`examples/blind-run/invented`](../examples/blind-run/README.md):

```
invented-store-tests · real tests classed at alpha 0.05 · chain head 6f15ae544a2c

test   kind           committed   call     revealed    real  p      status
hh-01  hero_headline  2026-01-12  B        2026-01-15  flat  0.858  winner_on_flat
hh-02  hero_headline  2026-01-12  flat     2026-01-15  flat  0.673  hit
hh-03  hero_headline  2026-01-12  B        2026-01-15  flat  0.328  winner_on_flat
hh-04  hero_headline  2026-01-12  flat     2026-01-15  flat  0.800  hit
hh-05  hero_headline  2026-01-12  no_call  2026-01-15  flat  0.558  not scored: no_call
bb-01  buy_box        2026-01-13  B        2026-01-15  B     0.006  hit
bb-02  buy_box        2026-01-13  flat     2026-01-15  B     0.015  flat_on_winner
bb-03  buy_box        2026-01-13  B        2026-01-15  A     0.019  wrong_winner
bb-04  buy_box        2026-01-13  flat     2026-01-15  flat  0.643  hit
bb-05  buy_box        2026-01-14  B        2026-01-13  B     0.007  not scored: revealed_unseen
bb-06  buy_box        2026-01-14  flat     -           -     -      not scored: sealed

kind           hit rate   wrong winner  winner on flat  flat on winner  no call  not scored                   always-flat
hero_headline  2/4 = 50%  0             2               0               1        0                            4/4 = 100%
buy_box        2/4 = 50%  1             0               1               0        1 revealed_unseen, 1 sealed  1/4 = 25%
all            4/8 = 50%  1             2               1               1        1 revealed_unseen, 1 sealed  5/8 = 63%

always-flat: the hit rate of calling every scored test flat. A hit rate at or below it adds nothing.
Simulated forecasts scored against real tests. A hit rate over a handful of tests is a count, not a calibration.
```

These numbers are made up; they are arranged so that every column and every status appears. The
two kinds read the same 50% and mean different things: on the invented headline tests the calls
did worse than always saying flat, on the invented buy box tests better. The pooled row hides that,
which is the reason for the split.

A hit rate is printed with its numerator and denominator and as `undefined (0 scored)` over an
empty set, never as 0%, following the results contract's rule for rates
([results-contract.md](results-contract.md)).

### Why a test is not scored

| status | meaning |
|---|---|
| `no_call` | the verdict was `continue`; counted in its own column |
| `open_book` | the test is `blind: false`: its outcome was public before any call |
| `pending` | no commitment and no outcome yet |
| `sealed` | committed, outcome not revealed |
| `no_commitment` | an outcome was revealed for a test that was never called |
| `protocol_changed` | the commitment was made under a different `protocol.json` |
| `seal_mismatch` | the revealed outcome does not hash to the seal in `tests.jsonl` |
| `no_counts` | the outcome has no visitor and conversion counts to class |
| `revealed_unseen` | the head the owner names does not contain this test's commitment (or names no row of the chain) |
| `revealed_early` | `revealedAt` is not after `committedAt` |

A test that is not scored stays in the listing and in the `not scored` column with its reason. It
is never dropped from the page.

## What the procedure does not close

- **The owner chooses the set.** They know the outcomes when they pick which tests to offer and
  which kind each is. Sealing stops an outcome changing; it does not stop selection. Offering every
  finished test in a period, rather than a chosen few, is the owner's part.
- **Leaks outside the files.** A model may have read a public result, and so may the person who
  wrote the persona or the scenario goal. The script cannot see either. This is why an outcome
  that has been posted anywhere makes its test `blind: false`.
- **Tuning between tests.** Revealing one test at a time and adjusting personas after each reveal
  turns the later calls into fitted ones. Reveal after the last commitment. A commitment read from
  a result carries the result's `requirementsDigest`, which covers the `analysis` section and the
  policies ([receipts-and-findings.md](receipts-and-findings.md)), so a changed analysis shows
  between rows; a changed persona does not.
- **Runs that were not committed.** One commitment per test does not show how many runs preceded
  it. The evaluation ledger counts the variants ever evaluated against a sample
  ([trial-ledger.md](trial-ledger.md)); it is not tied to the commitment.
- **Flat is a rule, not a fact.** A real test that ends at p 0.075 is flat at alpha 0.05 and may be
  a real effect measured on too few visitors. A call of B on it is counted as a winner on flat
  either way. The `p` column is printed so a reader can see how close each one was.
- **Small sets.** Eight scored tests in two kinds is four per kind. The report prints counts for
  that reason and makes no interval.
- **Two arms, one conversion metric.** Tests with more than one treatment and metrics where lower
  is better are outside the script.

## The nine tests in the thread

variflask described nine tests from one store. They are in
[`examples/blind-run/open-book`](../examples/blind-run/README.md) exactly as far as the thread
gives them, every row `blind: false`:

```sh
node scripts/blind-run.mjs score examples/blind-run/open-book
```

```
test                    kind           committed  call  revealed  real              p      status
button-copy             buy_box        -          -     -         flat              0.075  not scored: open_book
plan-picker             buy_box        -          -     -         flat              0.096  not scored: open_book
discount-in-plan-label  buy_box        -          -     -         flat              0.322  not scored: open_book
headline-only           hero_headline  -          -     -         flat (as posted)  -      not scored: open_book
page-rewrite            mixed          -          -     -         flat              0.172  not scored: open_book
skip-cart               unstated       -          -     -         flat              0.407  not scored: open_book
remove-price-line       unstated       -          -     -         flat (as posted)  -      not scored: open_book
video-takeover          unstated       -          -     -         flat (as posted)  -      not scored: open_book
still-running           unstated       -          -     -         -                 -      not scored: open_book
```

Three things follow.

1. **They cannot be run blind.** The visitors, conversions and p-values of most of them were
   posted before any call existed, in the same thread that asked for the run. A call made now
   would be made with the answers on the table, and the script will not score it. No call has been
   made on them and none is recorded here.
2. **The rule reproduces the posted numbers.** The four p-values variflask gave (0.075, 0.096,
   0.322, 0.172) are what the pooled z-test above returns for the posted counts, to three places.
   The headline test was posted as rates (0.99% against 1.01% on 11,255 and 11,265 visitors), and
   the price line and video tests as visitor counts only, so those three are classed as variflask
   posted them. The kind is given only where variflask gave it; the page rewrite "changed the
   headline plus benefit lines plus the buy box together" and is `mixed`.
3. **At alpha 0.05 none of the nine has a winner.** variflask said so: "none hit p under 0.05".
   A set like this, even held back, can fill only one of the three miss columns: every miss on it
   is a winner called on a flat test, and always-flat scores 100%. To exercise the wrong-winner and
   flat-on-winner columns a blind set needs real tests that moved, and the buy box tests that
   "leaned positive" would count as that only under a looser `alpha` fixed in `protocol.json`
   before the calls.

What a blind set needs is in the last question of that thread: finished tests whose results have
never been posted anywhere, sealed by their owner before the first run.
