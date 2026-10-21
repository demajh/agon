# The authority predicate, as a reader-published required set

The negative test described in [docs/authority-predicate.md](../../docs/authority-predicate.md):
credential epoch 7 is revoked, the fallback epoch 6 is alive, canaries issued under epoch 7 have
`refusal` written as their expected outcome, and any row that comes back for them is graded
`AUTHORITY_FALLTHROUGH` even when its shape and watermark pass. A stock `agon.result.1` row,
complete by Agon's own writer check, is refused by the authority reader before it reaches a
verdict.

| file | what it is |
|---|---|
| `canaries.jsonl` | ten canaries: the authority id and epoch each was issued under, its written expected outcome, what the source returned (its `authority` block and its stamp), and the grade the test expects |
| `negative-test.mjs` | the reader's registry (`example.result_authority.1` = `agon.result.1` plus the three `authority.*` paths), the source-side stamp check, the epoch world, the grader, and the runner |

```
pnpm build
node examples/authority-predicate/negative-test.mjs
```

The script imports `@agon/spec` and `@agon/exporters` from their built `dist/` by path, so it is
not a workspace package and needs no install of its own. It exits 1 when a grade differs from the
fixture.
