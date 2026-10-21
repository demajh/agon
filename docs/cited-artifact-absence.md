# Absence states for a cited artifact

A finding cites a receipt by id. A reader who follows the citation and gets nothing back has an
empty row in front of it, and an empty row can hide three different absences: the row was
deleted, the reader could not reach the row, or nobody ever looked. wan put the question that
starts this document on Moltbook:

> Curious how your results contract handles stale attestations — does a signed deletion ever
> expire, or is it valid forever once issued?

The short answer, which the rest of the document works out: a signed deletion never expires and
never covers more than the moment it was issued. It stays true of that moment forever. It is
never evidence about the present. What changes over time is the reader's state, and it changes
because new dated rows are written beside the old ones. Nothing is rewritten.

This is a specification for review. None of it is implemented yet. The next section describes
what Agon does today, and the rest describes what the contract asks for.

## What a blank means today

Citations in Agon point at results. A finding's `receiptId` names a result
(`packages/spec/src/receipts.ts`), and `receipt_id` is deliberately not a foreign key
(`packages/db/src/schema.ts`), so the finding outlives whatever happens to the row it names. Here is
what a reader that follows the citation sees:

| what happened to the receipt | what the reader gets |
|---|---|
| the run has not been analysed yet | `GET /v1/runs/{id}/results` answers 404 `not_found` |
| the environment was deleted (`DELETE /v1/environments/{id}`); the cascade removes its runs and results | `results.find` returns `undefined`; the route answers 404 `not_found` |
| the id was mistyped, or names a result from another server | the same 404 `not_found` |
| the reader's key is missing or wrong | 401 `unauthorized` |
| the server is down | a transport error and no Agon code |
| nobody followed the citation | nothing at all |

In local mode `agon compare` rewrites `result.json` on every run, so a later read of the same
path can return a different receipt with nothing to show that it changed. The first three rows of
the table cannot be told apart, and the last row leaves no record at all. That is the blank row
wan described.

## The five states

A reader that follows a citation records what it found as an **absence row**, one row per read:

| state | meaning | carries |
|---|---|---|
| `present` | the row was read | the row's id and, for a result, its `requirementsDigest` |
| `deleted` | the keeper produced a tombstone for the row | the tombstone (below), verbatim |
| `unreachable` | the read did not get an answer about the row | `readAt`, `route`, and the error code or transport failure |
| `unresolvable` | the keeper answered, but with neither the row nor a tombstone; or a tombstone has decayed (below) | `readAt`, `route`, and the reason |
| `never_asked` | no read of this citation exists | nothing beyond the citation itself |

`never_asked` is the state a report shows when it finds no read rows for a citation. It is not
written as a row, because writing it would itself be a read. A report that lists citations shows
it explicitly and never leaves the cell empty.

A 404 with no tombstone is `unresolvable`, not `deleted`. A missing row is not a claim that it
was deleted, because the keeper has not signed anything. Read today's table this way: every 404
there is `unresolvable`, a 401 or an outage is `unreachable`, and a citation nobody followed is
`never_asked`. Under the current code nothing can reach `deleted`, because the cascade leaves no
tombstone.

`readAt` is stamped from the clock of the store that writes the absence row, the same way the
findings repository stamps `closedAt`. The reader does not supply it. `route` names the read that
was attempted: the HTTP route and method (`GET /v1/runs/{id}/results`), the repository function
(`results.find`), or the file path in local mode.

## The tombstone

The **keeper** is whoever stores the row and can delete it: the server whose `results` table
held it, or the operator of the environment. A deletion that should be citable leaves this
record behind:

```ts
{
  citedId: 'res_…',              // the row that was deleted
  keeper: string,                // who deleted it and signs the tombstone
  issuedAt: string,              // when the keeper issued the deletion
  requirementsDigest?: string,   // the deleted receipt's digest, if it had one
  reason?: string,               // optional, free text
  signature: string,             // the keeper's signature over the canonical JSON of the fields above
}
```

The canonical JSON is the same one the requirements digest uses, with keys sorted at every level.
This document does not pick a signature scheme. It requires only that the tombstone can be checked
against the keeper's key without asking the keeper.

### A signed deletion is a claim about the moment it was issued

A tombstone says: *at `issuedAt`, `keeper` deleted `citedId`.* It does not say that the row is
absent now, that it was never restored, or that no copy exists anywhere else. So it never expires,
because a true statement about a past moment cannot become false. It also never answers a question
about the present. A reader who needs to know the current state has to read again.

This is the stance [receipts and findings](receipts-and-findings.md) take toward receipts: the
record says what was decided and when, and it is never re-judged. A tombstone is a receipt for a
deletion.

### A later read writes its own row

When a reader follows the citation again, it writes a new absence row with its own `readAt`. It
never edits, expires or deletes the earlier row. If the row has come back (`present`), or the
keeper can no longer be reached (`unreachable`), the history shows both rows in order. The current
state is derived from the newest row, and every earlier row stays as the record of what was seen
at its time.

The [lag ledger](results-contract.md#the-lag-ledger-and-its-closing-rule) follows the same rule,
closing an entry but never deleting it, and so does the [trial ledger](trial-ledger.md), which
only appends.

## A tombstone whose keeper is gone

A keeper can disappear: a server is decommissioned, an operator leaves, a key is retired. The
tombstone is still a true statement about `issuedAt`. What the reader loses is the ability to read
again and ask the keeper whether anything has changed since. There are two ways to handle that,
and the contract uses both, in this order.

1. **Co-signature by prior citers.** Before the keeper disappeared, other citers of the same row
   (other findings with the same `receiptId`, or other readers) may have read the citation and
   checked the tombstone's signature while the keeper was still reachable. Each such read is
   already an absence row: state `deleted`, the tombstone verbatim, and the citer's own `readAt`.
   A co-signature is nothing more than that row, and it needs no new mechanism. Only a citer whose
   citation is older than `issuedAt` counts, because only that citer had something to lose if the
   deletion was false. A citer who first arrived after the deletion has seen the tombstone and
   nothing else.
2. **Decay to `unresolvable`.** The reader sets a window, `tombstoneWindowMs`, the way the reader
   gate sets `quarantineTtlMs` ([results-contract.md](results-contract.md#the-ttl)). The window
   starts at the newest absence row that verified the tombstone while the keeper was reachable.
   Once it has passed with no further such row, and no co-signature from a prior citer exists,
   the reader derives `unresolvable` (reason `keeper_gone`) instead of `deleted`.

Decay changes the derived state and nothing else. The tombstone and every absence row stay where
they are. A reader that later finds the keeper again, or a prior citer's co-signing row, writes a
new row, and the derived state follows it. The stated window is what keeps the decay honest: a
reader who reports `unresolvable` can say exactly when and why the tombstone stopped counting.

## What the contract asks of each side

- **The keeper** deletes a citable row only by issuing a tombstone, and keeps serving the
  tombstone at the row's read route in place of a bare 404.
- **The reader** writes an absence row for every read, stamped by its store's clock, with the
  route. It never overwrites an earlier row. It reports `never_asked` explicitly, and reports
  `deleted` only with a tombstone whose signature verifies.
- **A report** shows the newest state for each citation, together with the `readAt` of the row it
  came from. A state with no date is a blank row under another name.

An absence row is a row like the others in the [results contract](results-contract.md) and would
be stamped with a schema version and a required set. `REQUIRED_SETS` in
`packages/spec/src/contract.ts` does not define a set for it.

## Open question for reviewers

Who counts as a prior citer? This document counts any citer whose citation is older than
`issuedAt`. A narrower rule would count only findings with the same `receiptId`, which the
findings table can list (`findings.list` with `receiptId`) and whose `createdAt` is stamped by the
repository, so it cannot be backdated. That makes the narrower rule checkable today, but it leaves
out external readers who cited the receipt in their own records. The wider rule includes them,
and then their citation dates are only as trustworthy as their own clocks.
