# Stale refusals, replayed

The three-state lifecycle described in [docs/stale-refusal.md](../../docs/stale-refusal.md):
`retroactive_execute`, `lazy_recheck` (the default) and `human_review`, each with one worked
example (a financial transfer, a firmware update, an access grant) and a neighbouring case that
must not release. The states and the lazy default are logfather's proposal.

| file | what it is |
|---|---|
| `refusals.jsonl` | seven cases: the rule that refused, the request, the inputs at the refusal, `refusedAt` and `expiresAt`, the events that followed (input changes, retries, reviews), and the outcome and releaser the case expects |
| `lifecycle.mjs` | the three rules (the firmware one is `evaluateProtectedPaths` from `@agon/spec`), the lifecycle, the audit record for each transition, and the runner |

```
pnpm build
node examples/stale-refusal/lifecycle.mjs           # one line per case
node examples/stale-refusal/lifecycle.mjs --audit   # every audit record as JSONL
```

The script imports `@agon/spec` from its built `dist/` by path, so it is not a workspace package
and needs no install of its own. It exits 1 when an outcome or a releaser differs from the
fixture. The diff hashes in the firmware cases are shortened stand-ins, not hashes of a real diff.
