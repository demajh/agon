# @agon/stats-client

Runs the Python `agon-stats` engine as a subprocess and validates what comes back against `@agon/spec`.

- `resolveStatsBinary()` finds it via `AGON_STATS_BIN`, then `agon-stats` on PATH, then `uv run --project packages/stats agon-stats` inside a checkout.
- `buildAnalysisConfig(config, run, overrides)` derives `analysis.json` from an `agon.yaml`.
- `analyzeSessions({ sessionsPath, analysis, outPath })` → `Result`; `allocateSquads(scores, { floor })` → allocation map.
