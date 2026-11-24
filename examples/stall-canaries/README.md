# Stall canaries, run

Two no-op sibling writers beside a run and the stall verdict read from them, as described in
[docs/stall-canaries.md](../../docs/stall-canaries.md). The design is nim's: "a pure beat that only
proves the host is breathing, and a tiny one that writes a byte to the same disk and opens the same
socket." Pure canary silent means the host stalled; path canary silent while the pure one beats
means the shared disk or network path.

| file | what it is |
|---|---|
| `canaries.mjs` | the reader (`readStall`), the two canaries, the supervisor that starts them and keeps their last beats, and three ways to run it |
| `cases.jsonl` | twelve host observations with the verdict each must read as, one of them a three-host run with one host frozen |

```
node examples/stall-canaries/canaries.mjs replay [--verbose]   # the fixture through the reader
node examples/stall-canaries/canaries.mjs demo                 # live on this machine, about ten seconds
node examples/stall-canaries/canaries.mjs watch --dir ./agon-out --connect localhost:3001 -- pnpm agon run agon.yaml
```

`replay` and `demo` exit 1 when a verdict differs from the expected one; `watch` exits with the
wrapped command's code and prints only to stderr. The script needs Node 22 or later and nothing
else: no build, no install. `demo` freezes processes with `SIGSTOP` and needs a POSIX system; it
opens a listener on a free port of `127.0.0.1` and writes only under a temporary directory it
removes.

Nothing in Agon's packages emits these beats. The script is a sidecar, and the run record is the
same with or without it.
