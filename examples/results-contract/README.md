# Regression case: one unstamped result under two candidate contracts

A reader of Agon's exports never infers a row's version from which fields it happens to carry
([docs/results-contract.md](../../docs/results-contract.md)). This example pins that rule from
the other side: it takes one result row that carries no stamp at all and shows what a consumer
may and may not conclude from it. The design is excelsior's, from a conversation on Moltbook:

> My proposed regression case would retain one immutable, versionless input and assess it under
> two named candidate contracts. Save both conditional results, keep the declared version absent,
> and show the consumer's admission decision separately.

| file | what it is |
| --- | --- |
| `unstamped-result.json` | The input: a valid `Result` with no `schemaVersion` and no `requiredSet`. Never edited; its digest is part of the case. |
| `regression.mjs` | Recomputes the case from the row with `@agon/spec` and compares it with the committed one. |
| `regression-case.json` | The committed case: the row, its digest, the declared version (absent), both conditional assessments, a validator's guess, and the admission decision. |

## Run it

From the repository root, after `pnpm install` and `pnpm -F @agon/spec build`:

```sh
node examples/results-contract/regression.mjs            # check: exit 1 on drift
node examples/results-contract/regression.mjs --write    # regenerate regression-case.json
pnpm exec prettier --write examples/results-contract     # after --write, so format:check passes
```

The check prints one line per candidate, the declared version, the guess and the admission:

```
agon.result.1 (2026-10-09.1): pass
agon.result.2 (2026-10-15.1, candidate): fail (missing decision.variant)
declared: {"schemaVersion":null,"requiredSet":null}
inference (newest-covering-candidate): agon.result.1
admission under agon.result.1: refused REQUIRED_SET_UNRESOLVED (unstamped)
ok: examples/results-contract/regression-case.json matches
```

## What the case keeps apart

The point of the fixture is that five things that are easy to collapse into one "version" field
stay separate, so that each can change without rewriting the others.

- **`row`** is the input as it was written, and **`rowDigest`** is `hashValue(row)` over its
  canonical JSON. The runner validates the row with `ResultSchema` and then discards the parsed
  value: the schema fills defaults (`kind`, `assumptions`, `warnings`), and a default is an
  inference. The row is assessed exactly as stored.
- **`declared`** is what the row says about itself, read with `readStamp`. For this row that is
  `null` twice, and the case keeps it `null`. As excelsior put it, the declared version stays
  absent rather than inferred: no rule in the runner writes a version into the row or into
  `declared`.
- **`candidates`** holds one conditional assessment per named candidate, computed with
  `missingFields` against the candidate's field list. The first candidate is the published
  `agon.result.1`, read from the registry. The second, `agon.result.2`, is not published: it is
  the same list plus `decision.variant`, for a consumer that needs every result to name a variant.
  The row passes the first and fails the second, and the failure names the missing field. Both
  outcomes are saved; neither is promoted to "the" version.
- **`inference`** records what a validator would guess under a named rule. The runner carries
  three rules (newest covering candidate, oldest covering candidate, never guess). The guess is
  labelled as a guess in the case itself.
- **`admission`** is the consumer's decision, and it is `checkRow(row, 'agon.result.1', registry)`
  with nothing added: the row is refused with `REQUIRED_SET_UNRESOLVED` and the placeholder id
  `(unstamped)`, which is what the reader gate records before quarantining such a row. The guess
  above does not feed into it.

## What the runner holds

Every run, before comparing with the committed case, the runner checks:

- the row in the case equals the input row, and the digest matches;
- `declared.schemaVersion` and `declared.requiredSet` are `null`, and neither key was written
  into the row;
- exactly two candidates were assessed, each with a name and a pass or fail;
- the admission is a refusal with `REQUIRED_SET_UNRESOLVED` and `(unstamped)`;
- rebuilding the case under each of the three inference rules changes only `inference`. The row,
  the declared version, the candidate assessments and the admission are identical under every
  rule, and no rule admits the row.

So updating an inference rule can change the guess, and publishing `agon.result.2` would change
the second assessment's `published` flag, without touching what the row originally stated and
without a validator's wrong guess becoming an admission. The committed case is the regression
target: if a change to `@agon/spec` makes `missingFields`, `readStamp` or `checkRow` answer
differently for this row, the check exits 1 and prints the section that moved.

The case does not edit the registry. `agon.result.2` here is a candidate for this fixture only;
publishing a set is a new id in `REQUIRED_SETS`, as the contract requires.
