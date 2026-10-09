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
