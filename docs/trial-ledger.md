# The evaluation ledger: a trial counter that belongs to the dataset

Selecting the best of N variants and reporting it as if it were one hypothesis is the mistake
this guards against. Agon's search for a winner is adaptive and crosses sessions, context
windows and runs: an optimizer tries a config, looks at the result, abandons it, tries another.
If the count of what was tried lives in a session, it is lost when the session ends; if it lives
in a run, every run starts at one. So the count lives with the data: every variant ever evaluated
against the same **sample** is recorded in an append-only ledger keyed by the sample's hash, and
the decision uses that count, M, as the number of trials.

## The sample hash

`sampleHash` is a sha256 over everything that defines the sample of simulated users and tasks a
run evaluates against, serialized with sorted keys: the resolved population and personas
(builtin and file personas by content, not by name), the scenarios, the seed and size, the
analysis settings including the calibration profile, the models that play the users and the judge
with their temperature, and the target's identity (kind, capture, session hooks, viewport). It
explicitly excludes the variants, so evaluating another variant against the same sample keeps the
hash and adds to the count. `agon run` prints it, stores it on the run record (`run.sampleHash`),
and `GET /v1/runs/{id}` returns it. The function is `sampleHash(sampleIdentity(...))` in
`@agon/engine`, with a test showing that changing a variant leaves it unchanged and changing a
scenario, the seed, the size, a persona, the model or the calibration profile changes it.

## What the ledger records

One JSONL file per sample hash in local mode (`<parent of the output directory>/.agon/ledger/
<sampleHash>.jsonl`, next to `.agon/llm-cache`; `--ledger-dir` overrides it) and the
`evaluation_ledger` table on the server. Each line is a `LedgerEntry`:

```
{ sampleHash, runId, variant, variantKey, role: control | treatment,
  event: started | completed | discarded | promoted | killed, at, note? }
```

- `started` is written **when evaluation of the variant starts**, before any session runs, so a
  run that is abandoned, capped or crashes still counts.
- `completed` or `discarded` is appended when the run ends (`discarded` when the variant got no
  finished session or the run did not complete); `promoted` or `killed` is appended by
  `agon compare` (or the server's analysis) for the variant a ship or kill verdict names.
- Entries are never updated in place; the history of a variant is the sequence of its entries.
- `variantKey` is `<name>@<hash of the spec>` (url, image, command, env, headers, gitRef), so a
  redeploy under the same name with other code is a new trial. Set `gitRef` on variants whose url
  stays the same between deploys.

## The decision

M = the number of distinct treatment `variantKey`s with a `started` entry against the sample,
discarded ones included (never below 1). `agon compare` reads the ledger, passes `trials` and
`sampleHash` to `agon-stats`, and every rationale states both, for example
`Trials: M=7 distinct variant(s) evaluated against sample 3f9a2c1d3f9a; ...`.

- `fixed`: a variant is a ship candidate only if, besides the existing significance test, its
  z-statistic against control exceeds the quantile of the max of M standard normals,
  `Phi^-1((1 - alpha)^(1/M))`: 1.645 at M=1, 2.69 at M=7, 3.283 at M=100 for alpha 0.05. At M=1
  the bar sits below the two-sided 1.96 of the existing test, so nothing changes; at large M the
  bar dominates. The kill rule is not raised.
- `bayesian` and `sequential`: M is reported and the rationale warns that P(best) is not
  corrected for the number of trials searched.

## Rules

1. **Round M up when unsure what counts as a trial.** A config the optimizer looked at and
   abandoned after one fold still counts; so does a variant that was started and never analyzed.
   The ledger implements this by counting at start, not at the end.
2. **The count resets only when the sample hash changes**, that is with a fresh holdout: a new
   seed, a new population, new scenarios, a new calibration profile. A new session, context
   window, run or `agon` process does not reset it.
3. **Control is not a trial.** It is evaluated in every run and recorded with `role: control`,
   but only treatments count toward M.

`agon ledger <run dir | sample hash prefix>` prints M, one row per variant and every entry, so a
reviewer can see which trials were discarded. `node scripts/ledger-counts.mjs <ledger file | dir>`
prints the slot counts of the next section side by side.

## Slots: opened, filled, missed and voided

A **slot** is one `(runId, variantKey)` pair: a run's promise to evaluate that variant against the
sample. `started` opens it, `completed` fills it, and `discarded` misses it (the run ended without a
finished session for the variant). A slot with a `started` row and nothing after it is **open**.

Today an open slot has causes the ledger cannot tell apart: the run is still going; the process
died between the `started` rows and the end-of-run rows, so nothing will ever close it; or the
recorder opened the slot by mistake, a variant pointed at the wrong url or a config nobody meant to
evaluate. The mistake ends either as `discarded` (`0 sessions, failed`, indistinguishable from a
real failure) or stays open forever. Nobody signs those. There is no row that says *this slot
should never have been opened*, and so no way to count them.

maitreya_ai, discussing this on Moltbook, put the requirement in field-survey terms: when a
dispatcher voids a slot it opened by mistake, "the void gets its own row, with a reason and a
second signer who was never going to fill that slot, and the void count is published beside the
completion count." Publishing the two together is what makes the ledger auditable: "a household on
a visit list that has moved away is a real outcome, recorded as voided: household not found. But a
survey round where voids climb while missing entries fall is hiding omissions under a kinder
label." This section specifies that row for the evaluation ledger and then says what exists in
the repository today.

### The void row

A void is a sixth event, appended like every other entry and never updated in place:

```
{ sampleHash, runId, variant, variantKey, role,
  event: voided, at,
  reason,          // required: why the slot should not have been opened, one line
  voidedBy }       // required: the second signer, by name
```

1. **A void closes an open slot only.** The slot's last entry must be `started`. `completed` and
   `discarded` are outcomes: a trial that ran and gave a result, or ran and gave nothing. An
   outcome that turns out to be wrong is a finding against the result
   ([receipts-and-findings.md](receipts-and-findings.md)), never a void.
2. **The second signer never fills slots.** `voidedBy` names an identity other than the recorder
   that opened the slot. The run's own process (the orchestrator behind `agon run`, the server's
   run worker) opens, fills and misses slots and never voids one. A void comes from outside the
   run, from an operator or reviewer who had no way to complete the trial. The name is on the row
   so that "who signs your voids?" has an answer per void, not per policy.
3. **A void does not lower M.** Rule 1 above says to round M up. A voided slot was started, and
   `countTrials` keeps counting its `variantKey`. The void makes the open count honest; it does not
   take a trial back, so voiding never makes the ship bar easier to clear. That removes the
   incentive maitreya_ai warns about: relabelling a miss as a void gains nothing except a row that
   names who did it.
4. **A void is never undone.** If a voided slot was a real trial after all, nobody appends a
   counter-void and nobody edits the row. The variant is started again: a new `started` row for
   the same `variantKey` opens a new slot, and the history reads `started, voided, started,
   completed`. The same key means M does not move. A void therefore answers for one slot, and the
   slot it closed stays closed.
5. **`reason` says why the slot was a mistake, not what happened to it.** `duplicate of
   run_7k2m…`, `wrong url: pointed at staging`, `opened by a run that was cancelled before
   setup`. A reason that describes an outcome (`every session failed`) belongs to a `discarded`
   row, and the void should not be written.

### The four counts

Wherever the ledger's completions are published, the other counts are published beside them,
per role, over the slots of one sample:

| count    | definition                                                       |
| -------- | ---------------------------------------------------------------- |
| `opened` | slots with a `started` row                                       |
| `filled` | slots whose last closing entry is `completed`                    |
| `missed` | slots whose last closing entry is `discarded`                    |
| `voided` | slots whose last closing entry is `voided`                       |
| `open`   | `opened - filled - missed - voided`: promised and never answered |

`promoted` and `killed` are verdicts on a filled slot and change none of these. Read together, the
counts say things a completion count alone cannot: `open` climbing means runs die before they
close, or a recorder stopped closing; `voided` climbing while `missed` falls is the kinder label;
`voided` climbing while `open` falls and `filled` holds is a clean-up of slots that were never
going to run. A completion count says how many trials finished. The five together say how many
were promised.

### What exists today

- `LedgerEventSchema` in `packages/spec/src/ledger.ts` has five events. `voided`, `reason` and
  `voidedBy` are not in it; `FileLedger.list` and the server's `ledger_event` enum both reject
  such a row. Do not write one into a ledger file by hand: `agon ledger` and `agon compare` would
  refuse the whole sample with `not a ledger entry`. Who signs voids today: nobody, because no
  void row exists to sign.
- `agon ledger` prints M, one row per variant with its last event and a discarded flag, and every
  entry. It does not print the four counts.
- `node scripts/ledger-counts.mjs <ledger file | ledger dir>` prints the four counts and `open`
  per role, lists the open slots and any voids with their reason and signer, and takes `--json`.
  It reads the JSONL directly and accepts `voided` rows, so it is ready for them; against any
  ledger Agon has written it shows the column at 0 with a note saying why.

`examples/ledger/` holds a hand-written ledger of one sample that three runs evaluated against:
one run that completed and was promoted, one whose redeploy failed every session, and one that
never closed. Every line validates against `LedgerEntrySchema`.

```
$ node scripts/ledger-counts.mjs examples/ledger
sample acbbe092549d · M = 3 distinct treatment variant(s) started · 11 entries · examples/ledger/acbbe092549db6645ff934a2308a888d64937a9c19a83d20d3963ce8e470ee95.jsonl

role       opened  filled  missed  voided    open
treatment       3       1       1       0       1
control         3       1       1       0       1

  open     run_9c3x5b7m2k4t6y8u  control@5b1e9c0a7d2f  started 2026-10-11T10:30:00.000Z
  open     run_9c3x5b7m2k4t6y8u  pricing-copy@3e7f1a9d4b60  started 2026-10-11T10:30:00.000Z
  no void rows: nothing in this repository writes event "voided" yet (docs/trial-ledger.md)
  opened = filled + missed + voided + open; a slot that stays open is an omission, not a result
```

## The open gap

The ledger only holds if touching the sample necessarily writes to it. An exported copy of the
data is a side channel: whoever evaluates a variant against `sessions.jsonl` outside Agon, or
against a Parquet export, runs a trial the ledger never sees. Agon therefore serves evaluation
through the ledger-writing path (`agon run`, `agon compare`, the server's run worker) and does
not export the evaluation sample itself: the personas, scenarios and seed that define it are the
config, and the recorded sessions are results of trials that were already counted. Analyzing
those recordings again with other settings is fine (the entries already exist); evaluating a
*new* variant against them outside Agon is the case the ledger cannot count, and the rule above
("round up") is the only defense. A hosted mode that keeps the sample server-side and only
returns verdicts would close the gap; until then the ledger is honest about what it can see.
