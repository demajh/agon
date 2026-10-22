# The subject under test, and when a pass goes stale

The staleness check described in [docs/results-contract.md](../../docs/results-contract.md#the-subject-under-test):
each result row names, per variant, the commit the app was built from and the sha256 of the
artifact the run exercised. A reader compares those with the build it would act on now, and serves
the result as a current pass only when every variant's digest still matches. The design point is
skitter-swarmmemo's, from a conversation on Moltbook: a pass should be declared stale when the
subject moves, even though `schemaVersion` and `requiredSet` did not change.

| file | what it is |
| --- | --- |
| `builds.json` | seven builds of the two-variant onboarding app: variant, commit, and the artifact's bytes (a short text standing in for the build output; `null` for one the reader cannot hash) |
| `cases.jsonl` | eight result rows: the builds each was tested on, the builds current when it is read, and the grade the check expects |
| `stale-check.mjs` | the reader's registry (`example.result_subject.1` = `agon.result.1` plus `subjects`), the writer-side stamp check, the grader, and the runner |

```
pnpm build
node examples/subject-digest/stale-check.mjs
```

The script imports `@agon/spec` and `@agon/exporters` from their built `dist/` by path, so it is
not a workspace package and needs no install of its own. It exits 1 when a grade differs from the
fixture, or when the stamp check accepts a subject that is a name rather than a resolved value.

```
case   verdict    gate                       grade                      served  reason
r_01   ship       ok                         SUBJECT_CURRENT            yes     -
r_02   ship       ok                         SUBJECT_STALE              no      treatment: digest moved
r_03   ship       ok                         SUBJECT_STALE              no      control: digest moved
r_04   ship       ok                         SUBJECT_STALE              no      treatment: same commit, other bytes
r_05   ship       ok                         SUBJECT_CURRENT            yes     treatment: commit moved, same bytes
r_06   ship       ok                         SUBJECT_UNVERIFIABLE       no      treatment: current digest unknown
r_07   kill       ok                         SUBJECT_UNVERIFIABLE       no      treatment: not in the current build
r_08   ship       REQUIRED_SET_NOT_SUPERSET  REQUIRED_SET_NOT_SUPERSET  no      -

passed the gate by shape: 7 (r_01, r_02, r_03, r_04, r_05, r_06, r_07)
current, served:          2 (r_01, r_05)
unresolved subjects refused at stamp: 2/2
grades as written:        8/8
```

## What the cases show

- **r_04 is why the digest is the key.** The treatment was rebuilt from the same commit with a
  drifted dependency. A reader that compared commits, or a CI build id that names the commit,
  would call this result current; the bytes the run exercised are gone.
- **r_05 is why the commit is not.** A docs-only commit produced identical bytes. The commit moved,
  the subject did not, and the pass still holds. The reason column records the move.
- **r_03: the control counts too.** A verdict is a comparison. When the control moves, the lift was
  measured against something that is no longer there, even if the treatment is untouched.
- **r_06 and r_07: no digest, no pass.** A reader that cannot hash what it would ship, or that no
  longer ships the variant, cannot confirm the result is about today's build. It does not serve it
  as current. It does not call it stale either, because nothing was shown to have moved.
- **r_08: silence is refused by the gate.** A stock `agon.result.1` row is complete for Agon's
  own writer, and the reader refuses it with `REQUIRED_SET_NOT_SUPERSET` (missing `subjects`)
  before any freshness verdict.

`SUBJECT_CURRENT`, `SUBJECT_STALE` and `SUBJECT_UNVERIFIABLE` are this example's grades, not gate
codes. The gate grades shape. Freshness depends on the reader's current build, which is not in
the row, so it is checked at serve time the way a watermark is.
