# The results contract: schema versions, required sets and the reader gate

A consumer of Agon's exports should never infer that a row is complete from which fields happen
to be populated: an empty column can mean "nothing happened" or "this writer did not know about
that field yet". So every row Agon exports is stamped at write time with two values. A reader
compares the stamp with what it needs, field by field, before it uses the row.

- `schemaVersion`: the version of the contract the row was written under, a date plus a
  counter (`2026-10-09.1`, `CONTRACT_SCHEMA_VERSION` in `@agon/spec`);
- `requiredSet`: the id of the **required set**, the list of fields a consumer may rely on at
  that version.

## The stamp

| row | where | stamp fields | required set today |
|---|---|---|---|
| session | `sessions.jsonl` | `schemaVersion`, `requiredSet` | `agon.session.1` |
| step | `steps.jsonl` | `schemaVersion`, `requiredSet` | `agon.step.1` |
| event | `events.jsonl` | `schemaVersion`, `requiredSet` | `agon.event.1` |
| result | `result.json` (the JSONL sink on the server, `agon compare` locally) | `schemaVersion`, `requiredSet` | `agon.result.1` |
| session row | `agon_sessions.parquet` | `schema_version`, `required_set` columns | `agon.session_row.1` |
| event row | `agon_events.parquet` | `schema_version`, `required_set` columns | `agon.event_row.1` |
| exposure row | `agon_exposures.parquet` | `schema_version`, `required_set` columns | `agon.exposure_row.1` |
| metric value row | `agon_metric_values.parquet` | `schema_version`, `required_set` columns | `agon.metric_value_row.1` |
| analytics event | every PostHog capture and Amplitude event (`$set`, `$identify`, exposures, events) | `agon_schema_version`, `agon_required_set` properties | `agon.analytics_event.1` |

Each spelling follows the row's own convention: camelCase on spec objects, snake_case in the
warehouse tables, and the `agon_` prefix the other simulation markers carry in analytics
properties. `readStamp(row)` reads any of the three. The JSONL `manifest.json` (now version 2)
lists the contract and the set of each file. The Parquet files carry `agon_schema_version` in
their key-value metadata. `run.json` is the run record, not a row, and is written as is.

A writer **refuses to stamp a row that lacks a field of its set**: the stamp is a promise
checked at write time, and `stampRow` throws a `ValidationError` that names the missing fields.
`null` counts as present, because a nullable column is part of the promise; a missing key or
`undefined` does not.

## The registry

`REQUIRED_SETS` in `packages/spec/src/contract.ts` maps every required-set id ever published to
`{ version, fields }`, with the field list written out (dotted paths for nested fields, such as
`persona.distinctId` or `properties.agon_run_id`). `CURRENT_REQUIRED_SET` names the id this build
stamps for each row kind.

- **An id resolves to the same list forever.** A change to a list is a new id (`agon.session.2`),
  never an edit of `agon.session.1`; a test pins the version-1 lists so an edit fails CI.
- **The registry has a generation**, which grows with every id published (`CONTRACT_REGISTRY`
  is generation 1). Readers built against an older generation catch up when it bumps (below).

## The superset rule

A reader declares the required set it was written against. A row is accepted only if its stamped
set is in the reader's registry **and its fields are a superset of the reader's**.

Why the id alone is not enough: ids are names, and names say nothing about fields. A reader of
`agon.metric_value_row.2` (which adds `unit`) must refuse a `.1` row, which lacks `unit`, even
though the ids share a prefix. A reader of `.1` can accept a `.2` row, which has everything `.1`
has. Another producer's set (say `vendor.metric_value_row.1`) is accepted exactly when it covers
the reader's fields, whatever it is called. The registry holds the field lists so that the
comparison is always on fields. `checkRow(row, readerSet, registry)` in `@agon/spec` is the pure
core of the rule, and it names the missing fields when it refuses.

Because the registry is a value the reader passes in, a reader can publish a set of its own that
asks for more than Agon's writers stamp. [authority-predicate.md](authority-predicate.md) does
this to require that every row say which authority it was read under, so that a row complete for
`agon.result.1` is refused rather than served as authority-valid.

### A regression case for an unstamped row

[examples/results-contract](../examples/results-contract/README.md) pins the rule from the
reader's side. One immutable `Result` with no stamp is assessed under two named candidate
contracts (the published `agon.result.1` and an unpublished `agon.result.2` that adds
`decision.variant`); the case saves both conditional assessments, keeps the declared version
`null`, records a validator's guess as a guess, and records the admission (`checkRow`, refused
with `REQUIRED_SET_UNRESOLVED` and `(unstamped)`) as its own field. Its runner checks that
changing the inference rule changes only the guess. The design is excelsior's.

## The reader gate

`RowGate` in `@agon/exporters` holds the rule for one reader (`readerSet`) with a quarantine,
a lag ledger and a clock. `ingest(row)` checks a row as it arrives; `serve(key)` hands out only
rows that passed; `bump(registry)` replays the quarantine against a newer registry. A row is
refused with one of three codes:

| code | meaning | at ingest | at serve |
|---|---|---|---|
| `REQUIRED_SET_UNRESOLVED` | the row's id is not in the reader's registry, or the row carries no stamp (recorded as `(unstamped)`) | quarantined with a bounded TTL | refused |
| `REQUIRED_SET_NOT_SUPERSET` | the id resolves but its fields do not cover the reader's | hard reject | refused |
| `QUARANTINE_EXPIRED` | the TTL ran out before the registry resolved the id | (the row left the quarantine when it expired) | refused with this code; the id is counted in the lag ledger |

**Nothing in the quarantine or in the lag ledger is ever served.** `serve` returns a row only
when it passed the superset rule, either at ingest or in a replay.

### The TTL

`quarantineTtlMs` (required, positive) bounds how long an unresolved row waits for the registry
to catch up. Expiry is checked lazily on every operation (`sweep()`), so a gate that sees no
traffic needs no timer. An unstamped row can never resolve, so it always expires. Its
`(unstamped)` lag-ledger entry counts the producers that do not stamp.

### Replay on bump

`bump(registry)` takes a registry with a strictly newer generation and re-checks every
quarantined row whose id the new registry resolves. Rows that now pass are returned in
`accepted` for the caller's normal pipeline. Rows whose set resolves but does not cover the
reader's are hard-rejected (`REQUIRED_SET_NOT_SUPERSET`). Rows still unresolved stay in
quarantine, with their TTL still running. Expired rows are not replayed: the only way back in
is to ingest the row again, which runs the same check as any new row.
`RowGate.restore(snapshot, { registry })` replays automatically when the registry has moved on
since the snapshot was taken.

### The lag ledger and its closing rule

When quarantined rows expire, their unresolved id is mirrored into the lag ledger, one entry
per (registry generation, id), with the number of rows, the earliest ingest (`firstSeenAt`) and
the first expiry (`expiredAt`). When a later bump resolves the id, the entry is **closed** with
`reconciledAt` and `reconciledGeneration`, and **never deleted**. The count of ids the registry
lagged behind, and how long each took to reconcile (`timeToReconcileMs`), outlive the replay
that fixed them. Closing an entry does not serve the rows it counted (see above).

### Storage

The gate is in memory with a serialisable snapshot: `snapshot()` / `RowGate.restore()`, and
`saveGateSnapshot(path, gate)` / `loadGateSnapshot(path)` for a JSON file, for example
`.agon/gate/<reader set>.json` next to `.agon/ledger`. The file exists for counting and for
restarts. It is not a source of rows to serve.

## Combining rows that passed the gate

The gate says whether a row may be used; it says nothing about how rows are combined once they
pass. A `VariantStats` carries `sessions` (the sessions with a value for the metric) and `mean`
over those, and the excluded count appears in the metric's `warnings`. A consumer that merges such
results across personas, models or shards has to add sums, valid counts and exclusions and divide
at the end, never average means. The [aggregation fixture](../examples/aggregation-fixture/README.md)
is a dataset and a test that pins this: the same rows merged through six partitionings give the
same result and exclusion counts, and an all-excluded partition contributes zero valid weight
rather than a zero-valued observation.

## Rates carry their eligible rows

The gate checks that a rate's fields are present. It does not check that the rate was computed
over anything. RushantsBro put the gap as a question on Moltbook: "Does your results contract
require a denominator to declare how many of its rows were eligible, or only how the numerator
was read?" Today, only how the numerator was read.

### What Agon reports today

A `VariantStats` carries `sessions` (the sessions with a value for the metric), `successes` for a
binary metric, and `mean`. That is the numerator and the measured count. The variant's other
sessions, and why they were left out, appear only as warning strings. In `agon-stats`:

- **An empty variant prints as zero.** When no session of a variant has a value for a metric,
  `analyze` writes `sessions: 0`, `mean: 0.0`, `stderr: 0.0`, `ci95: [0, 0]`, and the comparison
  against control a `lift` of `-1.0` (−100%). The `means` array is filled with zeros where the
  count is 0. Only a warning (`treatment: 6 of 6 sessions have no value for ...; excluded`) says
  the zero is not an observation.
- **A variant with no finished session disappears.** Sessions without an outcome are dropped
  before analysis (`build_result`). A variant all of whose sessions lack one is absent from every
  metric's `variants`, and the count lands as one warning on the first metric, with no variant
  named (`4 session(s) without an outcome were excluded from the analysis`).
- **A conversion is never unmeasured.** An absent conversion is read as "not converted", so every
  finished session is in the denominator, including one that never reached the step the event
  belongs to.

`scripts/run-report.mjs` already prints a pass rate over nothing as `n/a (0 completed)`
([run-termination.md](run-termination.md#reading-the-per-variant-counts)). The `Result` has no
equivalent.

### The rate row

A rate (any per-variant value computed as a numerator over a count of rows, so a proportion or a
mean) carries its denominator as four counts, kept apart from the numerator:

```json
{
  "metricId": "activation",
  "variant": "treatment",
  "numerator": 2,
  "denominator": {
    "raw": 8,
    "ineligible": [{ "reason": "no_outcome", "rows": 2 }],
    "eligible": 6,
    "measured": 5
  }
}
```

| count | meaning |
|---|---|
| `raw` | rows in scope: the variant's sessions in the run |
| `ineligible` | rows the metric does not apply to, as `{ reason, rows }` entries; every entry names its reason |
| `eligible` | rows the metric applies to; `raw = eligible + Σ ineligible.rows` |
| `measured` | eligible rows whose value was read; `measured ≤ eligible`, and `eligible − measured` is printed beside the value when it is not 0 |

The value is `numerator ÷ measured`. With `eligible = 0` or `measured = 0` it is **undefined** and
prints as `undefined (0 eligible: 6 no_outcome)` or `undefined (0 of 6 eligible measured)`, never
as `0.00`. "0 of 6 eligible sessions converted" is a zero; "6 sessions, none of them finished" is
not a rate at all, though both have numerator 0 and raw denominator 6.

Ineligible and unmeasured are two different counts on purpose. A session that never reached the
step a duration ends on is ineligible for it (the metric does not apply); a session that reached
it and whose value the recorder lost is eligible and unmeasured. `agon-stats` cannot tell the two
apart today: both are NaN, and both go into one warning. A row derived from today's output can
only put them in `eligible − measured`, which keeps the value undefined or flagged rather than
quietly smaller.

Merging rate rows adds all four counts, `ineligible` by reason, and the numerators, then divides
once, as the [aggregation fixture](../examples/aggregation-fixture/README.md) does for sums. A
shard with nothing eligible contributes zero rows, not a zero rate.

### The reader gate for rates

A reader that relies on this publishes the set itself, as for the subject under test below:
`example.rate_row.1` requires `numerator` and the four `denominator.*` counts. A producer whose
contract records only the numerator and the raw denominator is refused with
`REQUIRED_SET_NOT_SUPERSET` before anything else is read. Presence is not enough, because the stamp
counts `null` as present, so the reader grades the counts of every row that passed:

| grade | when | served as a rate |
|---|---|---|
| `RATE_DEFINED` | the counts add up and `measured > 0` | yes, with `eligible − measured` beside the value when not 0 |
| `RATE_ELIGIBLE_MISSING` | `eligible` is `null` or not a count | no |
| `RATE_ELIGIBLE_ZERO` | `eligible = 0` | no; prints `undefined (0 eligible: <reasons>)` |
| `RATE_UNMEASURED` | `eligible > 0`, `measured = 0` | no; prints `undefined (0 of N eligible measured)` |
| `RATE_REASON_MISSING` | an `ineligible` entry has no reason | no |
| `RATE_COUNTS_INCONSISTENT` | `raw ≠ eligible + Σ ineligible`, `measured > eligible`, or `numerator > measured` | no |

A refused row is still a true record of its counts, and a reader keeps it and counts it. What it
loses is the right to be read as a number. A comparison against a variant whose rate is not
`RATE_DEFINED` has no lift.

No set in `REQUIRED_SETS` has these fields, `VariantStats` does not carry `raw`, `eligible` or
`ineligible`, and no exporter writes a rate row. [examples/eligible-denominator](../examples/eligible-denominator/README.md)
runs both halves: `agon-stats` on a three-variant fixture, showing the zero mean, the −100% lift
and the vanished variant beside the denominator the contract asks for, and the gate on ten rate
rows, including the pair that differs only in `eligible`.

## The subject under test

The stamp says which contract a row was written under. It says nothing about *what was tested*.
A `ship` result stays complete for `agon.result.1` after the treatment is rebuilt, redeployed or
replaced, so a reader that checks only `schemaVersion` and `requiredSet` keeps serving a pass for
software that no longer exists. skitter-swarmmemo raised this on Moltbook, and asked:
"Which side do you store for agon's results: the digest of the generated software under test, or
only its build id?"

### What Agon stores today

Neither, on the result. A `Result` carries `runId`, and the run record (`run.json`) snapshots the
environment config, so each variant's spec (`url`, `image`, `command`, `env`, `headers`, `gitRef`)
is recoverable from the run. `gitRef` is whatever string the config gave, not a resolved commit,
and nothing hashes the artifact. The evaluation ledger's `variantKey` (`<variant>@<hash of its
spec>`, [trial-ledger.md](trial-ledger.md)) hashes that *declaration*. That catches a changed url,
image, command or ref. It does not catch new bytes behind the same url, a retagged `:latest`, or a
`gitRef: main` that has moved on.

### The field

Store both, and key on the digest. A result names one subject per variant of the run, because a
verdict is a comparison and a moved control invalidates it as surely as a moved treatment:

```json
"subjects": [
  { "variant": "control",   "commitSha": "<40 hex>", "artifactDigest": "sha256:<64 hex>" },
  { "variant": "treatment", "commitSha": "<40 hex>", "artifactDigest": "sha256:<64 hex>" }
]
```

- `artifactDigest` is the identity: the sha256 of the artifact the sessions ran against (the image
  digest for an `image` variant, the built bundle or binary otherwise). Same bytes, same subject.
- `commitSha` is provenance: the full commit the artifact was built from, so a reader can find the
  source and rebuild. It is not the identity, because one commit can build different bytes
  (dependency drift, a non-reproducible build) and a docs-only commit can build the same bytes.
- A build id alone is neither. It names a CI job, which can be re-run, and says nothing about the
  bytes.

A writer refuses to stamp a row whose `commitSha` is a ref (`main`) or whose `artifactDigest` is a
build number, the way `stampRow` refuses a row missing a field: a subject must be a resolved
value or the row does not claim it.

No set in `REQUIRED_SETS` has `subjects` yet, and no exporter writes it. A reader that relies on
it publishes the set itself, as [authority-predicate.md](authority-predicate.md) does:
`example.result_subject.1` is `agon.result.1` plus `subjects`, and a stock `agon.result.1` row is
refused with `REQUIRED_SET_NOT_SUPERSET` before anything else is read from it.

### How a reader treats a digest that no longer matches

Freshness is not a gate check. The gate grades the row's shape. Whether a subject still matches
depends on the build the reader would act on now, which is not in the row, so the reader checks it
at serve time, per variant:

| what the reader finds | grade | served as a current pass |
|---|---|---|
| every variant's current digest equals the row's | `SUBJECT_CURRENT` | yes |
| the same, but a commit moved (same bytes) | `SUBJECT_CURRENT`, the move noted | yes |
| any variant's current digest differs, whatever its commit | `SUBJECT_STALE` | no |
| a variant has no current digest the reader can compute, or is no longer built | `SUBJECT_UNVERIFIABLE` | no |

A stale result is not wrong and is never rewritten. It remains the receipt of what was tested on
the old bytes, as a result keeps the `requirementsDigest` it was accepted under
([receipts-and-findings.md](receipts-and-findings.md)). What it loses is the right to stand for
the current build. The decision it supported has to be re-earned by a run on the new digest.
`SUBJECT_UNVERIFIABLE` is kept apart from `SUBJECT_STALE` so that "we could not check" is counted
and never passes for "it moved", nor for "it is fine".

[examples/subject-digest](../examples/subject-digest/README.md) runs this: eight result rows
against seven builds, including the case a commit or build id gets wrong (same commit, other
bytes) and the case it gets wrong the other way (new commit, same bytes).

## When a cited row is missing

The stamp covers rows that exist. A finding can cite a receipt that is no longer there, or that
its reader cannot reach. What the contract asks for in that case (a signed tombstone for a
deletion, a dated row for each read, an explicit `never_asked`) is in
[cited-artifact-absence.md](cited-artifact-absence.md).

## Open question for reviewers

Should the expiry code live in the same table as the ingest quarantine? Today a row that expires
leaves the quarantine for a separate expired set, and `QUARANTINE_EXPIRED` is a serve-time code
next to the two ingest-time ones. The snapshot holds both collections side by side.

- **One table** would make "rows we hold and do not serve" a single place with a status column.
  It would also allow one replay path that could, in principle, revive an expired row when its id
  finally resolves.
- **Two tables**, the current choice, keep the quarantine to rows that may still become servable.
  Expiry stays a terminal state with its own semantics (no replay, counted per registry
  generation in the lag ledger), so an operator can tell "waiting for the registry" from "the
  registry was too late" without reading timestamps.

The answer decides whether expiry is a status of a quarantined row or an event in its history.
