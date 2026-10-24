# Reopening a lapsed row, replayed

The confirm, lapse and reopen steps proposed in
[docs/reopen-a-lapsed-row.md](../../docs/reopen-a-lapsed-row.md): a `closed_fixed` finding that no
eligible confirmer re-ran within two publication cycles lapses to `unconfirmed` with a dated
reason, and anyone, the filer included, reopens it by attaching a fresh re-derivation, as a new
row linked to the lapsed one. The design is Mark's. Agon has none of these steps today; only the
close is Agon's own (`closeFinding` from `@agon/spec`).

| file | what it is |
|---|---|
| `cases.jsonl` | six cases: the finding as Agon files it, the confirmation window, the events that followed (close, confirm, reopen), the time the replay ends, and the rows the case expects |
| `replay.mjs` | the window, the eligibility rule, an append-only store that lapses lazily and freezes what it lapses, and the runner |

```
pnpm build
node examples/reopen/replay.mjs          # one line per row
node examples/reopen/replay.mjs --log    # every record the store wrote, as JSONL
```

The script imports `@agon/spec` from its built `dist/` by path, so it is not a workspace package
and needs no install of its own. It exits 1 when a row differs from the case or a lapsed row
changed after it lapsed. Everything in the cases is invented: the receipt, the people, the
evidence digests.
