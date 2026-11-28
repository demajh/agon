# Blind scoring against real A/B tests, on two sets

Two set directories for `scripts/blind-run.mjs`, the procedure in
[docs/blind-run.md](../../docs/blind-run.md): a call per test (A, B or flat) committed before the
real outcome is revealed, and a report with three miss counts beside the hit rate (wrong winner,
winner called on a flat test, flat called where the real test had a winner), split by test kind.
The three columns and the hero/headline against buy box split are variflask's, from a Moltbook
thread.

| directory | what it is |
|---|---|
| `invented/` | eleven invented store tests, sealed, called, and all but one revealed, arranged so that every column and every not-scored reason appears |
| `open-book/` | the nine tests variflask described, as far as the thread gives them, all `blind: false` |

```sh
node scripts/blind-run.mjs score examples/blind-run/invented
node scripts/blind-run.mjs score examples/blind-run/open-book
node --test scripts/blind-run.test.mjs      # needs pnpm build and uv sync --project packages/stats
```

`score` needs only Node. The test also records a run with the engine's fakes, runs `agon compare`
on it and commits the verdict from the `result.json` that wrote.

## `invented/`

Nothing here was measured and no Agon run produced the calls. The visitor and conversion counts
were chosen to land on each side of p 0.05; the calls were entered with
`commit --verdict … --at …` (`source: manual` in every row) so that the set shows two winners
called on flat headline tests, one wrong winner, one flat called on a winner, a no-call, an outcome
revealed before its commitment was seen (`bb-05`), and one test still sealed (`bb-06`). The nonces
are hashes of the test ids so the fixture can be rebuilt; a real nonce is random.

`outcomes.jsonl` holds the nonces, so every seal in `tests.jsonl` can be recomputed:

```sh
node scripts/blind-run.mjs seal examples/blind-run/invented/outcomes.jsonl
```

To see the refusals, try a second call on a committed test (the file is not changed):

```sh
node scripts/blind-run.mjs commit examples/blind-run/invented hh-01 --verdict kill
```

```
refused: hh-01 already has a commitment (seq 1, B, 2026-01-12T09:10:00.000Z); one call per test
```

## `open-book/`

variflask's nine tests with the numbers posted in the thread and nothing added: counts where they
were given, `posted: "flat"` where only visitors or rates were, no outcome row for the test still
running, and `kind` only where variflask named it. `postedP` is the p-value from the thread; the
test checks that the script's own z-test returns the same value to three places. There is no
`commitments.jsonl`: the outcomes were public before any call could be made, so none was, and
`score` reports every row as `open_book` with the hit rate undefined.
