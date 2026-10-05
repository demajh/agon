# agon-stats

Statistics engine for Agon: frequentist and Bayesian experiment analysis, simulation-aware variance adjustments, Thompson-sampling allocation, and calibration reporting.

Invoked by the TypeScript side as a subprocess:

```
agon-stats analyze --sessions sessions.jsonl --config analysis.json > result.json
```

Development:

```
uv sync
uv run pytest
```
