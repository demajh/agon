# A coverage record: a reader test

A receipt says what a result was accepted *under* ([docs/receipts-and-findings.md](../../docs/receipts-and-findings.md)):
the requirements digest, the metrics, the policies. It says nothing about what the result was
computed *from*. When a ship verdict later looks wrong, "what was missing from it?" has two
different answers that are easy to confuse: somebody decided to leave a source out (a **selection
dispute**), or a source was asked for and never came (a **capture failure**). This directory holds a
synthetic record built so that a reader has to tell them apart, and a checker that grades the
reader.

The design is iris-rights-dialogue's, from a conversation on Moltbook: keep a bounded inventory of
sources as three distinct sets, nominated, selected and received, with every entry naming who
proposed it and why it was included or excluded; make sure the synthetic artifact contains "both a
nominated source excluded without explanation and a selected source that never arrives"; and
"require the reader to distinguish selection dispute from capture failure", even when the
observer's own success message is intact. Dated additions appear as scope revisions, never as
rewrites of the original list.

Agon has no coverage-record type today. This is an example of the shape, not a feature, and
everything in it is invented: the run, the result, the dates, the people.

## Files

| file | what |
|---|---|
| `coverage-record.json` | the record: subject, the observer's message, the original three sets, two dated revisions |
| `expected-verdicts.json` | the answer key: one verdict per source with the reason, the overall verdict, and the traps |
| `sample-answers.json` | a reader who trusted the success message; fails three items |
| `check.mjs` | validates the record, derives every verdict from set membership, compares with the key, grades answers |

```sh
node examples/coverage-record/check.mjs                                                    # validate, derive, compare with the key
node examples/coverage-record/check.mjs --answers examples/coverage-record/sample-answers.json  # grade a reader
node examples/coverage-record/check.mjs --json
```

Exit 0 when the record is well formed, the key agrees with the sets and the answers (if given)
agree with the key; 1 otherwise. Node >= 22, no dependencies.

## The three sets

Every source has an id. The record keeps three lists, and a source moves through them in order:

- **nominated**: `{ id, proposedBy, why }`. Who put it forward and why.
- **selected**: `{ id, by, included, why }`, one entry per nominated source. `included: false`
  with a string `why` is an explained exclusion; `included: false` with `why: null` is an
  exclusion whose reason was never recorded. The key is always present, so a blank is visible as
  a blank and not as a missing field. An inclusion must have a reason.
- **received**: `{ id, by, status, receivedAt, detail }`, for selected sources. `status` is
  `usable`, `unusable` or `missing`; a missing source has `receivedAt: null`.

The subject here is a ship verdict for the `ledgerly-onboarding` demo experiment
(`examples/demo-app/agon.yaml`). The sources are the ones such a decision draws on: the two
arms' sessions, the population, the judge score, two personas and a scenario that squads
nominated, and a pre-release and a post-release live window for the gate in
[docs/live-window-recorder.md](../../docs/live-window-recorder.md). The observer's message is the
release pipeline's: the run's `termination.kind` was `completed`, `agon compare` printed `SHIP`
with its receipt line, the live-window step was skipped because its input file did not exist, and
the pipeline went green. Every line of it is true. `check.mjs` prints that the message is intact
and then never reads it.

## Verdicts

The verdict of a source follows from which sets it is in and what the entries say. Nothing else.

| in nominated | selected entry | received entry | verdict |
|---|---|---|---|
| yes | `included: true` | `usable` | `covered` |
| yes | `included: false`, `why` a string | — | `excluded_explained` |
| yes | `included: false`, `why: null` | — | `selection_dispute` |
| yes | `included: true` | `missing`, `unusable` or absent | `capture_failure` |

The overall verdict is the worst one present, in the order of that table. A capture failure
outranks a selection dispute because the two are settled differently, and the ranking stops the
cheaper settlement from being applied to the dearer problem:

- A **selection dispute** is a scope matter. The result is complete under the scope it was given;
  the scope was narrowed without saying why. It is settled by a dated revision that records the
  reason or widens the selection, and, if the widening changes the requirements, by a new
  digest. The receipt is not touched.
- A **capture failure** is an evidence matter. The result was accepted as if it covered the
  source, and it did not. It is settled by capturing the source or by redoing the acceptance
  without it, openly. Revising the scope so that the source was never selected is the one move
  the record exists to make visible, and the no-rewrite rule below forbids it.

In the record, `persona:file/accessibility-screen-reader` was nominated by the accessibility
reviewer and excluded with `why: null`: a selection dispute. `live-window:live@4-replicas` was
selected with a concrete request (a window, a grain, a capacity label) and never arrived: a
capture failure. The expected overall verdict is `capture_failure`, with the success message
intact.

## Dated revisions

`revisions` is a list of dated batches, in order, each with `by`, a `note`, its own three sets,
and `annotations`. A revision may only add: an id that already appears in a set cannot appear in
that set again, and `check.mjs` refuses a record that tries (`a revision adds entries, it never
rewrites one`), as it refuses a revision dated before the batch it follows. Two revisions show
the two ways a later fact enters without rewriting the original list:

- **2026-10-14**, SRE: a second live window, three days after the release, as a *new source*
  (`live-window:live@4-replicas#2026-10-14`), selected and received usable. Its verdict is
  `covered` as of that date. The original window stays `missing`, and the acceptance of
  2026-10-10 was made without it.
- **2026-10-15**, release owner: the reason the screen-reader persona was excluded, supplied five
  days late as an *annotation*. The original entry keeps its `why: null`; the annotation carries
  the date the reason was given. The verdict for the original list stays `selection_dispute`.

Every derived verdict carries `asOf`, the date of the batch that nominated the source, so a reader
can say what the record showed on the day the decision was reviewed.

## The traps

`expected-verdicts.json` lists the wrong answers the test is built to catch, and `check.mjs`
names the trap when a reader falls into one:

1. Grading the unexplained exclusion as a `capture_failure`. A source that was never selected
   cannot fail to arrive; this blames the instruments for a decision somebody made.
2. Grading the missing live window as a `selection_dispute`. Nobody disputed its place in the
   scope; it did not arrive. Calling it a dispute invites settling it by revision.
3. Grading the missing live window as `covered` because a later window arrived. The later window
   is a different source, added by a dated revision.
4. Grading the whole record `covered` because the pipeline was green. The message is intact and
   true, and none of its lines is about the live window.

`sample-answers.json` falls into the first, second and fourth.

## Writing your own

Copy `coverage-record.json`, replace the subject and the sets, and run `check.mjs` against the
new file as its first argument (`node examples/coverage-record/check.mjs my-record.json`). The
checker requires that the record still contains at least one unexplained exclusion and one
selected source that never arrived, because a reader test without both cannot tell whether the
reader distinguishes them. For a record of a real decision rather than a test, drop that
requirement by deleting `requiredCases`; the structural checks and the derivation stand on their
own.
