# agon-stats

Statistics engine for Agon: frequentist and Bayesian experiment analysis, simulation-aware
uncertainty (cluster-robust intervals, effective sample size, variance decomposition),
Thompson-sampling allocation, and calibration provenance. Pure Python 3.12 on numpy, scipy and
pyarrow; invoked by the TypeScript side as a subprocess with JSON / JSONL / Parquet I/O.

```
uv sync
uv run pytest
uv run ruff check .
```

## CLI

```
agon-stats analyze --sessions sessions.jsonl --config analysis.json [--out result.json]
                   [--result-id res_x] [--computed-at 2026-10-04T17:00:00.000Z]
agon-stats allocate --scores '[{"squad":"blue","wins":3,"runs":5}]' [--floor 0.1] [--seed 0]
agon-stats --version
```

Both commands print JSON to stdout (or `--out`) and exit 0. Any failure prints
`{"error": {"code": "<config_error|validation_error|not_found|internal_error>", "message": "..."}}`
to stderr and exits 1. With no sub-command the CLI prints `{"ok": true, "version": "..."}`.

### `analyze` input

`--sessions` is one of:

- `.jsonl`: one `Session` object per line, exactly as `@agon/spec` defines it (camelCase; the
  persona id and model live in `persona.personaId` / `persona.model`). Sessions without an
  `outcome` (pending / running) are excluded and counted in a warning.
- `.json`: an array of the same objects, or `{"sessions": [...]}`.
- `.parquet`: one row per session. Columns may be snake_case or camelCase: `id`, `run_id`,
  `variant`, `scenario_id`, `persona_id`, `model`, `outcome`, `steps`, `cost_usd`, `metrics`
  (JSON string, struct or map) and the judgement either as a `judgement` struct / JSON string or as
  flat `judgement_success`, `judgement_satisfaction`, `judgement_frustration`,
  `judgement_confidence`, `judgement_summary` columns. A nested `persona` struct is accepted too.

`--config` is the analysis document the engine derives from `agon.yaml`'s `analysis` block
(all keys except `runId` are optional and default as in `AnalysisSchema`):

```json
{
  "runId": "run_k7f2m9x1",
  "control": "control",
  "method": "bayesian",
  "minSessionsPerVariant": 30,
  "decision": { "shipIf": 0.95, "killIf": 0.05 },
  "alpha": 0.05,
  "clusterBy": ["persona", "model"],
  "calibrationProfile": "uncalibrated-v0",
  "changeCategory": "copy",
  "seed": 0,
  "metrics": [
    { "id": "activation", "type": "conversion", "event": "project_created", "primary": true },
    { "id": "time_to_activate", "type": "duration", "from": "session_start", "to": "project_created" },
    { "id": "frustration", "type": "score", "source": "judge", "score": "frustration" }
  ],
  "draws": 20000,
  "bootstrapSamples": 1000,
  "mixtureVarianceScale": 0.01
}
```

### `analyze` output

A `Result` as defined in `packages/spec/src/result.ts`: `id` (`res_<runId suffix>`), `runId`,
`method`, `control`, `primaryMetricId`, `metrics[]` (`MetricResult`: `metricId`, `direction`,
`variants[]`, `comparisons[]`, `varianceDecomposition`, `warnings`), `decision`
(`verdict`, optional `variant`, `rationale`), `calibration` (`profile`, optional
`changeCategory`, optional `directionAccuracy`, `note`), `sessionsAnalyzed`, `computedAt`,
`engine`. Optional fields are omitted rather than written as `null`; every number is finite.

`scenario_success` (1 if the session's outcome is `success`) is always the first metric; the
primary metric is the configured metric flagged `primary`, else `scenario_success`.

Per-session metric values: `conversion` is 0/1 from `metrics[id]` (absent = 0); `count` is
`metrics[id]` or 0; `duration` is `metrics[id]` in seconds or missing; `steps` is `metrics[id]` or
the session's step count; `score` is `metrics[id]` or the judge's `satisfaction` / `frustration`.
Missing values exclude the session for that metric and are reported in `warnings`.

## Methods

- **fixed**: pooled two-proportion z-test for binary metrics, Welch's t-test for continuous
  ones; relative lift `(mean_v - mean_c) / mean_c` with a delta-method 95% interval.
- **sequential**: mixture SPRT always-valid p-value (normal approximation):
  `Lambda = sqrt(V / (V + tau^2)) * exp(tau^2 d^2 / (2 V (V + tau^2)))`, `p = min(1, 1 / Lambda)`,
  with `d` the observed difference, `V` its estimated variance and
  `tau^2 = mixtureVarianceScale * pooled variance` (default 0.01). Conservative relative to the
  fixed-horizon p-value by design; the fixed p-value is also computed and available on the Python
  `Comparison` object.
- **bayesian** (default): Beta(1,1)-Binomial posteriors for binary metrics, Normal-Normal with a
  weak prior for continuous ones; 20,000 seeded Monte Carlo draws give `pBest` over all variants,
  `pBeatControl`, `expectedLoss` (expected regret in the metric's good direction, metric units) and
  a 2.5-97.5% credible interval for the relative lift.

The verdict is computed on the primary metric: `continue` while any variant has fewer than
`minSessionsPerVariant` sessions; for `bayesian`, `ship` when the best treatment's `pBest >=
shipIf`, `kill` when every treatment is `<= killIf` and control is `>= shipIf`, otherwise
`inconclusive`; for `fixed` / `sequential`, `ship` when a treatment's p-value is below alpha
(Bonferroni-divided across treatments) with the lift in the good direction, `kill` when every
treatment is significantly worse.

## Simulation-aware uncertainty

Sessions sharing a persona x model (x scenario) are not independent users. With `clusterBy`
non-empty, uncertainty comes from a seeded paired cluster bootstrap (1000 replicates by default):
cluster keys are resampled with replacement and every variant's mean is recomputed from the drawn
clusters, so per-variant `stderr` / `ci95` reflect "a different draw of personas and models",
while the lift interval and the difference's standard error come from the joint replicates
(shared persona effects cancel, as in a blocked design). Clustering is never allowed to make a
comparison more certain than iid sampling. `effectiveSampleSize` uses the Kish design effect
`n / (1 + (mean cluster size - 1) * ICC)`. With fewer than three clusters in a variant the metric
falls back to iid with a warning. `varianceDecomposition` reports the share of post-variant
variance between personas, between models (and between scenarios when several exist) versus
residual, normalized to sum to 1.

## Calibration

Every result carries a `CalibrationNote` from the bundled `profiles.json` registry. The shipped
`uncalibrated-v0` profile has no benchmark agreement rate, so its note says so; unknown profiles
produce a note saying the profile is unknown rather than failing.

## Allocation

`allocate` draws 10,000 samples from `Beta(wins + 1, losses + 1)` per squad, takes the share of
draws in which each squad is best, and mixes in a uniform floor so every squad keeps at least
`--floor` of the allocation. Output: `{"allocation": {"blue": 0.6, ...}}`, summing to 1.
