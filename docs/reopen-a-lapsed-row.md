# Reopening a lapsed row

A finding closed as `closed_fixed` says the invariant holds, by the settlement's predicate, as one
observer saw it once ([receipts-and-findings.md](receipts-and-findings.md)). Nobody has to look
again. If the counted thing is published on a cycle (a weekly export, a monthly report), a second
look on a later cycle is what separates "it held" from "it held the week we checked".

Mark asked on Moltbook: "Does agon have anything like a reopen step, or once a row is closed is it
closed?" The design on this page is theirs: a row that no eligible confirmer re-ran within a
waiting time tied to the counted thing's publication cycle (two cycles, say) lapses to
`unconfirmed`; it keeps its dated lapse record and reason; anyone, including the filer, can reopen
it by attaching a fresh re-derivation; and the reopen is a new linked row, never an edit of the
lapsed one. This page says what Agon has today, then proposes the fields. The example that replays
the proposal is [`examples/reopen/`](../examples/reopen/).

## What Agon does today

Once a row is closed it is closed. There is no confirm step, no lapse and no reopen:

- `FindingStatusSchema` in `packages/spec/src/receipts.ts` is `open`, `closed_fixed`,
  `closed_tolerated`. There is no `unconfirmed`.
- `closeFinding` and `findings.close` in `@agon/db` close an open finding once; the update is
  conditional on `status = 'open'`, and a second close gets a `ConflictError`. Nothing moves a
  closed finding anywhere else.
- The settlement names one `observer`, and at close carries their `observedAt` and
  `observedUnder`. A second observer, a deadline for one, and a record of who re-ran the predicate
  have no field.
- The documented route back is "if the problem returns, file a new finding against the receipt
  that let it through". The new finding names the same `receiptId`, but nothing links it to the
  earlier finding, and it is filed because the problem came back, not because nobody confirmed
  the fix.
- Receipts (results) have no status at all. A result is written once per run and never edited, so
  there is nothing on it to lapse.

So half of Mark's shape is already there: rows are not edited after the fact, and a later act is a
new row. What is missing is the clock, the confirmer, the lapse record and the link.

## The proposal

Four steps on a finding. The first exists; the other three are proposed.

| step | from | to | who | what is written |
|---|---|---|---|---|
| close | `open` | `closed_fixed` | the closure owner, with the observer's stamp | `closedAt` (store's clock), `observedAt`, `observedUnder`; the window's `dueAt` follows |
| confirm | `closed_fixed`, before `dueAt` | `closed_fixed`, confirmed | an eligible confirmer | `confirmed`: who, when, under which pin |
| lapse | `closed_fixed`, unconfirmed at `dueAt` | `unconfirmed` | the store | `lapse`: when, why, the window, the re-runs that did not count |
| reopen | `unconfirmed` | a new `open` row | anyone, the filer included | the new row, with `reopens` and `rederivation` |

Only `closed_fixed` waits for confirmation. `closed_tolerated` says the invariant does not hold
and someone carries that; there is no claim to confirm.

### Fields on the finding

```ts
{
  // ...every field FindingSchema has today, unchanged...
  status: 'open' | 'closed_fixed' | 'closed_tolerated' | 'unconfirmed',

  confirmation?: {                // set when the finding is filed; copied onto a reopen
    cycle: string,                // the counted thing's publication cycle, ISO 8601 ('P7D')
    cycles: number,               // how many cycles the window runs after closedAt (2)
    publishes: string,            // what publishes on that cycle, so a reader can find it
    eligible: string[],           // who may confirm; the settlement's observer never counts
  },

  confirmed?: {                   // written once, by an eligible confirmer, before dueAt
    by: string,
    at: string,                   // when they re-ran the predicate
    under: string,                // the version pin they re-ran it under (the later cycle's output)
    verdict: 'holds',
  },

  lapse?: {                       // written once, by the store; the row is frozen from then on
    lapsedAt: string,             // = dueAt = closedAt + cycles × cycle: when the window ran out
    recordedAt: string,           // when the store noticed; the gap is itself information
    window: { cycle, cycles, publishes, eligible },  // as it stood, so a later edit of the policy is visible
    reason: 'no_rerun' | 'no_eligible_rerun',
    ineligibleReruns: { by: string, at: string, under: string, why: string }[],
  },

  reopens?: string,               // on a new row: the id of the unconfirmed row it reopens
  reopenedBy?: string,            // who reopened it; may be the filer
  rederivation?: {                // required with reopens
    at: string,                   // when the predicate was re-derived
    under: string,                // the version pin it was re-derived under
    evidence: string,             // a digest or locator of what was re-derived
    verdict: 'holds' | 'fails',
  },
}
```

`dueAt` is not stored; it is `closedAt` plus `cycles` cycles, and storing it would give two
places to disagree.

### The rules

1. **The window is counted in the counted thing's cycles, not in days.** A weekly export with
   `cycles: 2` gives two chances to re-run the predicate on output the fix did not produce for the
   first observer. The `publishes` line names the output, so a confirmer knows what to re-run on.
2. **The observer does not confirm their own observation.** A re-run by the settlement's
   observer, or by someone not in `eligible`, is refused as a confirmation and kept, with the
   reason, in the lapse record if the row lapses. A lapse with `no_eligible_rerun` and two
   ineligible re-runs reads differently from a lapse nobody touched.
3. **Lapse is lazy and stamped by the store.** Nothing needs to watch a clock: the window is
   looked at whenever the row is touched or listed, as Agon's lazy recheck does for a stale
   refusal ([stale-refusal.md](stale-refusal.md)). `lapsedAt` is the deadline, so it does not
   depend on when someone happened to look; `recordedAt` is when the store wrote it. Neither is
   supplied by a caller, the same way `closedAt` is not.
4. **A lapsed row is frozen.** Like `close`, the lapse is a conditional update (`status =
   'closed_fixed'` and no `confirmed`), so it happens once. After it nothing on the row changes:
   not a late confirmation, not a reopen.
5. **A re-run after the deadline is not a confirmation.** It is refused with the deadline in the
   reason, and the same work becomes a reopen by attaching it as the re-derivation.
6. **Anyone may reopen; nobody reopens without a re-derivation.** The filer, the closure owner,
   the observer, an outsider: reopening only says "here is a fresh look", and the look is on the
   record. A reopen with no re-derivation, or of a row that is still `open` or still inside its
   window, is refused.
7. **The reopen is a new row.** It copies the receipt, invariant, impact, closure owner,
   settlement (without the observer's stamp), requirements digest and window, starts `open`, and
   names the lapsed row in `reopens`. It closes and is confirmed through the same steps, with its
   own window. "Was this ever reopened?" is a query (`reopens = <id>`), not a field on the lapsed
   row, so the lapsed row never needs to change to answer it.

A re-derivation whose verdict is `fails` still reopens the row: the problem is open again, and
the new row says so with evidence attached. That is close to the existing "file a new finding",
with the link to the row it follows.

### Receipt rows

A result has no status and is never rewritten, so it cannot lapse in place. The same shape would
apply as separate rows keyed by `receiptId`: a confirmation row that re-derives the result under
the same `requirementsDigest`, a lapse row written by the store when the window passes without
one, and a reopen row carrying the re-derivation and naming the lapse. The result itself stays as
it is, as "supersede the policy, never the receipt" requires.

### Storage

On the `findings` table this would be a migration adding `unconfirmed` to the `finding_status`
enum and nullable `confirmation`, `confirmed` and `lapse` (jsonb), `reopens` and `reopened_by`
(text) and `rederivation` (jsonb) columns, with an index on `reopens`. `reopens`, like
`receipt_id`, would not be a foreign key. Repository functions `confirm`, `lapseDue` and `reopen`
would sit beside `close`. None of this exists; it is the proposal.

## Running it

`examples/reopen/cases.jsonl` holds six cases on one invented finding (an activation export that
double-counted users, confirmed on the weekly export, two cycles): `confirmed`, `lapsed`,
`observer_only` (the observer and the filer re-ran it; neither may confirm), `late_rerun` (a
re-run a day after the deadline, refused, then filed as a reopen), `filer_reopens` (the filer
reopens, is refused without a re-derivation, then reopens with one; the new row closes and is
confirmed by someone else) and `reopen_too_early`. The close step is `closeFinding` from
`@agon/spec`, imported from its built `dist/`; the confirm, lapse and reopen steps are written in
the script.

```
pnpm build
node examples/reopen/replay.mjs
```

```
case              row               status        lapse              reopens       by      confirmed by
confirmed         fnd_dedupe_a      closed_fixed  -                  -             -       ana-r
lapsed            fnd_dedupe_b      unconfirmed   no_rerun           -             -       -
observer_only     fnd_dedupe_c      unconfirmed   no_eligible_rerun  -             -       -
late_rerun        fnd_dedupe_d      unconfirmed   no_rerun           -             -       -
late_rerun        fnd_dedupe_d.r1   open          -                  fnd_dedupe_d  teo     -
filer_reopens     fnd_dedupe_e      unconfirmed   no_rerun           -             -       -
filer_reopens     fnd_dedupe_e.r1   closed_fixed  -                  fnd_dedupe_e  mara    ana-r
reopen_too_early  fnd_dedupe_f      closed_fixed  -                  -             -       teo

lapsed rows unchanged after lapse: 4/4
cases as written: 6/6
```

`--log` prints every record the store wrote, refusals included, as JSONL. The script hashes each
row when it lapses and again at the end, and exits 1 if a lapsed row changed or any row differs
from the one written in the case.
