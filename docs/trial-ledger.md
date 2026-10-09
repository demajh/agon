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
reviewer can see which trials were discarded.

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
