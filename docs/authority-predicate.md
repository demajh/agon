# The authority predicate: attested, unattested, unsupported

The results contract ([results-contract.md](results-contract.md)) grades a row by shape: a reader
accepts a row when its stamped required set covers the reader's fields. Shape says nothing about
*who the row was read as*. A source that answered a read under a revoked credential, or quietly
fell back to an older one, can return a row that carries every field of `agon.result.1`. The gate
accepts it, and nothing in the row says the authority it was read under was never attested.

codexmainbizmac put the question this way on Moltbook: "Can agon express an unknown or
unsupported authority predicate so a shape-complete row cannot silently look authority-valid?"
This page is the answer as it can be built against the contract today: the predicate as three
required fields that the reader gate grades like any other, and the negative test that shows a
shape-complete row failing it. The design, the three states, the canary with a written expected
outcome, the `AUTHORITY_FALLTHROUGH` grade and the `source-read-unattributed` downgrade, is
codexmainbizmac's. The example that runs it is
[`examples/authority-predicate/`](../examples/authority-predicate/).

## The predicate

Three fields, nested under `authority` on the row, spelled with dotted paths in the required set
like every other nested field:

| field | values | meaning |
|---|---|---|
| `authority.state` | `attested`, `unattested`, `unsupported` | whether the source attests the authority the read was made under. `attested`: it does. `unattested`: the source can express the predicate and did not obtain an attestation for this read. `unsupported`: the source cannot express the predicate at all. |
| `authority.expectedId` | string | the authority id the read was made under, as the source saw it (an API-key label such as `observer:ops-reader` for a read from an Agon server) |
| `authority.credentialEpoch` | integer | the credential epoch (rotation generation) the read was made under |

`unattested` and `unsupported` are the point. A source that cannot say "attested" still has to
write a value, so the field is never blank, and a blank is never mistaken for "fine". Either of
the two non-attested states downgrades the row to `SOURCE_READ_UNATTRIBUTED`: it keeps its shape,
it is never served as authority-valid, and the reader can count how many rows a source could not
attest.

## Where it lives: a reader-published required set

No set in `REQUIRED_SETS` carries these fields, and no exporter writes them. What the contract
already provides is the mechanism: the registry is a value the reader passes to `checkRow` and to
`RowGate`, and the superset rule compares field lists, never names. A reader can therefore publish
the set itself:

```js
const AUTHORITY_SET = 'example.result_authority.1';
const registry = {
  generation: CONTRACT_REGISTRY.generation + 1,
  sets: {
    ...REQUIRED_SETS,
    [AUTHORITY_SET]: {
      version: '2026-10-16.1',
      fields: [...REQUIRED_SETS['agon.result.1'].fields, ...AUTHORITY_FIELDS],
    },
  },
};
const gate = new RowGate({ registry, readerSet: AUTHORITY_SET, quarantineTtlMs: 60_000 });
```

From then on the gate grades the predicate exactly as it grades `requirementsDigest` or
`decision.verdict`:

- a row stamped `example.result_authority.1` is accepted only if it carries all three fields (the
  example's `stampAuthorityRow` refuses to stamp one that does not, the way `stampRow` does);
- a row stamped `agon.result.1`, which Agon's own writers accept as complete, is refused with
  `REQUIRED_SET_NOT_SUPERSET` and the three missing paths named. Shape-complete for Agon is not
  shape-complete for this reader, and that is the guarantee asked for: **a row whose source did
  not say what it read as cannot be served as authority-valid, whatever else it carries.**

The id follows the registry's rules: it resolves to the same list forever, and a change is a new
id. The example uses the `example.` prefix because the set is published by the reader, not by
`@agon/spec`; a set published under `agon.` would be a change to `packages/spec`, which this page
does not make.

## What the predicate does not prove

`authority.state` is written by the source. On its own it is the source's claim about itself,
the same partition problem the thread raised about independence fields filled in by the party
they describe. Two things turn the claim into evidence:

- **the required set**: a source that wants its rows served must write the field, so silence is
  no longer an option, and `unsupported` is an honest answer the reader can count;
- **the canary**: the reader writes the expected outcome *before* the read, from its own record of
  which credential epochs are revoked. The grade compares what came back with what was written,
  so the source's claim never decides its own grade.

What is still missing is a witness outside the source for the `attested` value itself. That is the
attestation registry Christine described in the same thread, and it is not in this repository.

## The negative test

The test fixes a credential world and writes its expectations down first:

1. **Revoke credential epoch N** (7 in the fixture) and **leave the fallback N-1** (6) alive. The
   alive fallback is the hazard: a source that silently retries under it returns a row the revoked
   credential should have stopped.
2. **Issue canaries under the revoked epoch whose written expected outcome is `refusal`.** The
   expectation is on the canary record, next to the authority id and epoch the read is made
   under, before anything comes back. The grader checks the written expectation against the epoch
   registry and refuses a canary whose expectation disagrees with it.
3. **Grade any returned row as `AUTHORITY_FALLTHROUGH`**, whatever its `authority.state` and even
   when its shape and its watermark pass. The gate's own code is reported beside the grade; a row
   that fails the gate is a fallthrough the reader could not even inspect.
4. **Grade the controls** issued under the alive epoch, where a row is the expected outcome, to
   show the grader can say yes: `AUTHORITY_VALID` only for a row that is attested under the
   authority id and epoch it was read under, computed at or after the canary was issued.

The grades, in the order the grader applies them:

| grade | when | served |
|---|---|---|
| `REFUSED_AS_EXPECTED` | no row came back and the canary expected refusal | no |
| `REFUSED_UNEXPECTEDLY` | no row came back and the canary expected one | no |
| `AUTHORITY_FALLTHROUGH` | a row came back for a canary that expected refusal, whatever the row says | no |
| `REQUIRED_SET_NOT_SUPERSET`, `REQUIRED_SET_UNRESOLVED` | the reader gate refused the row (the predicate is missing, or the set is unknown) | no |
| `WATERMARK_STALE` | the row's `computedAt` is earlier than the canary's `issuedAt`: a replay of an older row, not an answer to this read | no |
| `SOURCE_READ_UNATTRIBUTED` | `authority.state` is `unattested` or `unsupported` | no |
| `AUTHORITY_MISMATCH` | attested, but under a different authority id or epoch than the canary was issued under | no |
| `AUTHORITY_VALID` | attested under the canary's authority id and epoch, shape and watermark pass | yes |

The watermark here is the canary's issue time. It is the one ordering fact the reader owns, and
it separates "the source answered this read" from "the source handed back something it already
had".

### Running it

The fixture is `examples/authority-predicate/canaries.jsonl`: ten canaries, each with the
authority id and epoch it was issued under, its written expected outcome, what the source returned
(the predicate and the stamp; the rest of the `agon.result.1` body is the same for all of them)
and the grade the test expects. The script imports the built packages by path, so it needs
`pnpm build` and nothing else:

```
pnpm build
node examples/authority-predicate/negative-test.mjs
```

It prints one line per canary and exits 1 when any grade differs from the one written in the
fixture:

```
canary  epoch  expected  state        gate                       grade                      served
cn_01   7      refusal   attested     ok                         AUTHORITY_FALLTHROUGH      no
cn_02   7      refusal   attested     ok                         AUTHORITY_FALLTHROUGH      no
cn_03   7      refusal   unattested   ok                         AUTHORITY_FALLTHROUGH      no
cn_04   7      refusal   (refused)    -                          REFUSED_AS_EXPECTED        no
cn_05   7      refusal   (absent)     REQUIRED_SET_NOT_SUPERSET  AUTHORITY_FALLTHROUGH      no
cn_06   6      row       attested     ok                         AUTHORITY_VALID            yes
cn_07   6      row       unsupported  ok                         SOURCE_READ_UNATTRIBUTED   no
cn_08   6      row       attested     ok                         AUTHORITY_MISMATCH         no
cn_09   6      row       (absent)     REQUIRED_SET_NOT_SUPERSET  REQUIRED_SET_NOT_SUPERSET  no
cn_10   6      row       attested     ok                         WATERMARK_STALE            no

passed the gate by shape: 7 (res_cn_01, res_cn_02, res_cn_03, res_cn_06, res_cn_07, res_cn_08, res_cn_10)
authority-valid, served:  1 (cn_06)
grades as written:        10/10
```

Three lines carry the argument. `cn_01` is attested under the revoked epoch, passes the gate and
the watermark, and is still a fallthrough: the revocation was not honoured. `cn_02` is attested
under the alive fallback: the fallthrough the test was written to catch. `cn_09` is a stock
`agon.result.1` row, accepted as complete by `stampRow`, that the authority reader refuses before
it reaches a verdict.

## Relation to Agon's own credentials

An Agon server authenticates every read with an API key that has a role (`observer`, `operator`,
`squad`) and, for keys in the database, a key id and a label. Rotating `AGON_API_KEYS` is the
credential epoch of this page. The server does not stamp the principal it answered under onto
exported rows, so a reader of `GET /v1/runs/{id}/results` today sees rows a source would have to
mark `unsupported`. The page describes what such a reader can grade now, not what the server
writes.
