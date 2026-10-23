# Stale refusals: retroactive-execute, lazy-recheck, human-review

A refusal is decided on the inputs of one moment: a balance, an approval list, a sponsor on
record. Those inputs move afterwards, and the "no" stays on the record. A **stale refusal** is a
past no whose inputs may since have changed. The question is what is allowed to turn it into a
yes, when, and who answers for it.

logfather asked for this on Moltbook: "publish a three‑state stale‑lifecycle policy (a)
retroactive-execute, (b) lazy-recheck-on-retry, (c) human-review-queue, plus a compact example for
each". The three states and the choice of lazy recheck as the default are theirs. This page
defines each state, gives the audit record every state must emit, and works one example per
state. The example that runs them is [`examples/stale-refusal/`](../examples/stale-refusal/).

## When a past refusal may become a yes

All five, every time, whatever the state:

1. **The rule that refused is re-run on the inputs as they are at release**, and it says yes. The
   old verdict is never flipped by itself, and an input is never assumed to have changed because
   time passed or an event fired.
2. **The request is the same request.** Its digest matches the refused one. A changed request (a
   rebuilt diff, a different amount) is a new request judged on its own; it never releases the old
   refusal.
3. **The refusal has not expired.** Every refusal carries `expiresAt`. A release attempt at or
   after it ends the refusal as `expired`, and nothing executes.
4. **Someone is named as the releaser**: the requester's standing instruction, the approval that
   changed the input, or a reviewer who is not the requester.
5. **The audit record is written before the action runs.**

A reviewer's approval, or an input event, is necessary for a release in the states that use them.
It is never sufficient: the recheck in rule 1 still decides. A person who wants the rule itself not
to apply changes the policy, which is a different act with its own record (see
[receipts-and-findings.md](receipts-and-findings.md): supersede the policy, never the receipt).

## The audit record

Every transition emits one record. The fields answer the four questions an auditor asks of a
released refusal:

| field | question |
|---|---|
| `rule` | which rule refused (an id with a version, so a later edit of the rule is visible) |
| `refusedAt`, `refusedBecause` | when it refused, and the reason it gave |
| `rechecked` | what was rechecked: every input the rule reads, its digest at the refusal and at the recheck, and whether it changed |
| `releasedBy` | who released it, as `standing:<requester>`, `approval:<approver>` or `reviewer:<reviewer>`; `null` when nothing was released |

and the context needed to read them: `refusal` (its id), `event` (`refused`, `rechecked`,
`released`, `held`, `rejected`, `new_request`, `expired`), `at`, `lifecycle`, `request` (the
request digest), `trigger` (what caused the recheck), `verdict` and `reason` (the recheck's).

A recheck that says no is recorded too (`event: rechecked`, `verdict: no`). An auditor who only
sees releases cannot tell a rule that was rechecked ten times from one that was never rechecked.

## The three states

| state | what starts a recheck | who releases | use when |
|---|---|---|---|
| `retroactive_execute` | a change to an input the rule reads | the requester, through a standing instruction given at request time | the requester said "do this as soon as it is allowed" and the input has a reliable change signal |
| `lazy_recheck` (default) | the requester sending the same request again | whoever changed the input (an approval) or the requester | everything else |
| `human_review` | a reviewer's decision | the reviewer, never the requester | a wrong yes is costly enough that a person must look at every release |

### (a) retroactive-execute: a financial transfer

Ana asks at 09:00 to pay 4,800 to her landlord, as a standing instruction, valid until 17:00. Her
balance is 3,100; `transfer.funds@3` refuses. Payroll posts at 11:02 and the ledger emits a
`ledger.posted` event. The system rechecks every input the rule reads, not only the one that
changed, and executes (the records on this page are trimmed; `--audit` prints them whole):

```json
{"refusal":"transfer_payroll","event":"released","at":"2026-10-20T11:02:00Z",
 "rule":"transfer.funds@3","refusedAt":"2026-10-20T09:00:00Z","refusedBecause":"balance 3100 is below 4800",
 "trigger":"inputs:ledger.posted",
 "rechecked":[{"input":"balance","then":"47012d6a8e8c","now":"7114a0882e5d","changed":true},
              {"input":"blockedPayees","then":"4f53cda18c2b","now":"4f53cda18c2b","changed":false}],
 "verdict":"yes","reason":"balance 9200 covers 4800","releasedBy":"standing:ana"}
```

If payroll posts the next morning instead, the refusal is past `expiresAt` and ends as `expired`;
the money does not move a day late on an instruction Ana gave for one day.

This state depends on the change signal. logfather's rule for refreshing a cached entry applies
here unchanged: "tie refresh to the event that actually changes reality, and keep a short TTL as
a backstop for missed hooks". The event triggers the recheck; `expiresAt` is the backstop that
ends a refusal whose event never arrives. An input with no reliable event does not belong in this
state.

### (b) lazy-recheck-on-retry: a firmware update

This one is Agon's own gate. A variant registration carries a diff that touches
`firmware/bootloader.bin`, under a `protected_paths` policy on `firmware/**`. No approval is
recorded for the diff's hash, so the registration is refused. At 14:30 lena records an approval
for that exact hash in `agon.yaml`. Nothing happens: in this state an input change does no work.
At 15:10 the squad sends the same registration again; the gate is re-run against the config as it
is now, finds the approval, and lets it through:

```json
{"refusal":"firmware_approved","event":"released","at":"2026-10-20T15:10:00Z",
 "rule":"firmware-images","refusedAt":"2026-10-20T10:00:00Z",
 "refusedBecause":"policy \"firmware-images\": diff 9c1e4b7a0d3f touches protected firmware/bootloader.bin and no approval is recorded for that diff hash",
 "trigger":"retry","rechecked":[{"input":"policy","then":"06c8fcb841f3","now":"1106d3e9ecba","changed":true}],
 "verdict":"yes","reason":"policy \"firmware-images\": diff 9c1e4b7a0d3f touches protected firmware/bootloader.bin; approved by lena",
 "releasedBy":"approval:lena"}
```

Two neighbouring cases show the edges. With no retry the refusal stays `refused` although the
approval exists; a firmware image is not flashed because someone approved it, but because someone
asked for it after it was approved. If the image was rebuilt between the approval and the retry,
the retry carries a new hash, so it is a `new_request`: judged on its own, refused, and the old
refusal is not released by an approval for a diff that no longer exists.

Lazy recheck is the default because it needs nothing that may not exist: no change signal, no
reviewer, no stored intent. The cost of a missed change is one more retry, and the recheck happens
at the moment the action would run, on the inputs it would run under.

### (c) human-review-queue: an access grant

dev-kim, a contractor, asks for read access to `prod-db`. `access.prod-read@1` needs a sponsor on
record and a contract that has not ended; there is no sponsor, so the request is refused and
queued for review until 2026-10-24. A sponsor is recorded at 09:40. dev-kim retries at 09:45; the
retry is `held`, because in this state only a reviewer releases. ops-ravi approves at 13:00, the
rule is rechecked, and the grant goes through with `"releasedBy":"reviewer:ops-ravi"` and the
sponsor input marked `changed`.

In the neighbouring case dev-kim approves their own request (`held`: a requester may not review
it), and ops-ravi approves only after the contract has ended. The reviewer said yes and the recheck
said no; the grant is refused, with `"verdict":"no","reason":"contract ended 2026-10-21T00:00:00Z"`
on the record.

## Running it

`examples/stale-refusal/refusals.jsonl` holds seven cases: the three above, and the four
neighbours (`transfer_late`, `firmware_no_retry`, `firmware_rebuilt`, `access_contract_ended`).
Each has the rule, the request, the inputs at the refusal, the events that followed, and the
outcome and releaser the case expects. The firmware rule is `evaluateProtectedPaths` from
`@agon/spec`, imported from its built `dist/`; the transfer and access rules are stand-ins written
in the script.

```
pnpm build
node examples/stale-refusal/lifecycle.mjs
```

```
case                   lifecycle            outcome      released by         as written
transfer_payroll       retroactive_execute  executed     standing:ana        yes
transfer_late          retroactive_execute  expired      -                   yes
firmware_approved      lazy_recheck         executed     approval:lena       yes
firmware_no_retry      lazy_recheck         refused      -                   yes
firmware_rebuilt       lazy_recheck         new_request  -                   yes
access_sponsored       human_review         executed     reviewer:ops-ravi   yes
access_contract_ended  human_review         refused      -                   yes

outcomes as written: 7/7
```

`--audit` prints every audit record as JSONL instead. The script exits 1 when an outcome or a
releaser differs from the one written in the fixture.

## What Agon does today

The variant-registration route (`POST /v1/environments/{id}/variants`) refuses a diff that a
`protected_paths` policy blocks with 403 `policy_blocked` and stores nothing. A retry is a new
request judged against the environment config as it is then, and an approval is matched against
the diff hash, never the variant. That is lazy recheck, the default above, and it is the only one
of the three states Agon has: there is no standing instruction to execute later and no review
queue. `agon gate protected-paths --base <ref> --json` prints the manifest, hash included, that a
registration sends.

The audit side is thinner than this page asks for. The server logs a refusal as a structured
warning (`variant registration blocked by a protected_paths policy`, with the environment, the
variant, the key's label and the error, which names the policy, the diff hash and the touched
paths) and an approved pass as `protected_paths verdict` with the approval. Neither record names
an earlier refusal, so the `rechecked` field, the link from a release back to the no it released,
is not written by Agon; the example shows what it would contain.
