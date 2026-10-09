# Receipts and findings

A result says "ship", "kill", "continue" or "inconclusive". When a shipped variant later causes an
incident, two questions follow: what was the result accepted under, and what was missing from
it? Agon answers the first with a **receipt**, the requirements digest every result carries, and
the second with a **finding**, a record that names the receipt and the invariant the incident
showed was missing. The rule that ties them together: **supersede the policy, never the
receipt.**

## Results are receipts

Every `Result` carries `requirementsDigest`, a sha256 over the canonical JSON (keys sorted at
every level) of the parts of the configuration that decided its acceptance:

- the `analysis` section: method, control, decision thresholds (`shipIf`, `killIf`), `alpha`,
  `minSessionsPerVariant`, `clusterBy`, the calibration profile, and the **materiality
  boundary** (below);
- the `metrics`;
- the `policies`: squad policies and the policy gates (`protected_paths`, `side_effects`,
  `shadow_diff`).

The variants are deliberately outside it: evaluating another variant under the same rules gives
the same digest, and changing a metric, a policy or the boundary gives a new one (tests in
`packages/spec/src/receipts.test.ts`). Overrides that change the decision (`agon compare
--method`, `--control`, `--min-sessions`, `--profile`) are applied before hashing, so the receipt
names the requirements it was actually accepted under. The analysis seed and the change category
are not requirements.

`requirementsDigest(config)` lives in `@agon/spec`. `buildAnalysisConfig` hands the digest to
`agon-stats analyze`, which echoes it on the Result. The digest shows in `result.json`, in
`GET /v1/runs/{id}/results`, and in `agon compare` output
(`receipt: model under requirements 3f9a2c1d3f9a, 4 assumption(s) recorded`). A result computed
before receipts existed has no digest; the field stays absent and is never backfilled.

Every result also carries a `kind`. It is `model` for anything computed before a release from
simulated sessions; every `agon-stats analyze` result is a model, with an `assumptions` list
saying what the forecast takes for granted. It is `measurement` for an observation of the live
window ([live-window-recorder.md](live-window-recorder.md)). A model is a rehearsal and a
measurement is what happened, and the receipt says which one it is.

## The materiality boundary

`analysis.materiality.fields` lists the output fields that count as decision-relevant: dotted
paths with globs, such as `outcome`, `metrics.activation` or `response.total`. An optional `note`
says why the boundary sits where it does. The `shadow_diff` gate reads it: a field inside the
boundary that the gate's contract does not name counts as a disallowed difference.

Because the boundary is part of the analysis section, it is versioned under the requirements
digest. After an incident, moving a field into the boundary produces a new digest that every
future attempt is judged under. Every past receipt keeps the digest, and so the boundary, it was
accepted under. Nothing is re-judged retroactively.

## Findings

A finding names a receipt, carries the invariant the incident showed was missing, and has an
owner who closes it:

```ts
{
  id: 'fnd_…',
  receiptId: 'res_…',            // the result the finding names
  invariant: string,             // what must hold from now on
  impact: string,                // what happened because it did not
  closureOwner: string,          // who closes it
  status: 'open' | 'closed_fixed' | 'closed_tolerated',
  settlement: {
    predicate: string,           // the observable condition under which it counts as settled
    observer: string,            // who applies the predicate
  },
  requirementsDigest?: string,   // the requirements version the receipt was accepted under
  createdAt: string,
  closedAt?: string,             // set exactly when the finding is closed
}
```

The schema is `FindingSchema` in `packages/spec/src/receipts.ts`. The settlement names a predicate
and an observer so that the change that fixes the problem never declares its own success:
someone other than the fix applies a stated test.

### The two closure states

- **`closed_fixed`**: the invariant now holds, by the settlement's predicate, as applied by its
  observer.
- **`closed_tolerated`**: the invariant does not hold, and the closure owner accepts that. The
  finding records who carries the risk.

An open finding has no `closedAt`, and a closed one must have it. A finding is closed once and
never reopened; if the problem returns, file a new finding against the receipt that let it
through.

### Storage

Findings are stored next to results, in the `findings` table (migration
`0004_receipts_and_findings`, which also adds `kind`, `assumptions` and `requirements_digest` to
`results`). The repository functions in `@agon/db` are `findings.insert`, `get`, `find`, `list`
(newest first, filtered by `receiptId` and `status`, paginated) and `close`. `close` updates only
a row whose status is still `open`, so two concurrent closes cannot both win; the loser gets a
`ConflictError`. `receipt_id` is not a foreign key: a finding keeps naming its receipt whatever
happens to the result row. There is no HTTP route or CLI command for findings yet. They are
written through the repository, and the routes are the next step once the review settles the
shape.

## Supersede the policy, never the receipt

When an incident shows that a requirement was too weak:

1. **File a finding** against the receipt that let the variant through, with the missing
   invariant, its impact, a closure owner, and the settlement predicate and observer. Name the
   receipt's `requirementsDigest`: that version of the requirements is now superseded.
2. **Change the requirements**: add or tighten a metric, add a policy gate, or move a field into
   the materiality boundary. The digest changes, and every future attempt is judged under the
   new one.
3. **Leave the receipt alone.** It is not edited, re-analysed under the new rules, or deleted. It
   records what was decided and under which rules, and that record is what the finding points at.
4. **Close the finding** as fixed or tolerated once its settlement predicate has been applied.

What this does not cover yet: on the server a run keeps one result row. The run worker writes it
once, when the run's analysis completes. The repository's `upsert` would replace it if the same
run were analysed again, which Agon does not do today. In local mode `agon compare` rewrites
`result.json` each time it runs. If a receipt matters, keep the file, or rely on the finding's
`receiptId` and `requirementsDigest`, which do not change.
