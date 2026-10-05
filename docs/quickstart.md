# Quickstart: your first simulated experiment

Ten minutes, on a laptop, against the bundled demo app. You need Node 22+, pnpm, uv, and an Anthropic or OpenAI API key. Docker is only needed for the server (not for local runs).

## 1. Build

```sh
pnpm install && pnpm build
uv sync --project packages/stats        # the Python statistics engine
pnpm -F @agon/adapters exec playwright install chromium
```

## 2. Start the two variants of the demo app

Ledgerly is a small bookkeeping SaaS with two onboarding flows: `control` (five steps) and `treatment` (one prefilled step).

```sh
VARIANT=control   PORT=3001 pnpm -F @agon/demo-app dev &
VARIANT=treatment PORT=3002 pnpm -F @agon/demo-app dev &
```

## 3. Look at the experiment definition

```sh
pnpm agon validate examples/demo-app/agon.yaml
pnpm agon plan     examples/demo-app/agon.yaml -n 10
```

`plan` shows exactly which personas, scenarios and models would run, and the worst-case spend, without touching a browser or a model. The full schema is in [agon-yaml.md](agon-yaml.md).

## 4. Run it

```sh
export ANTHROPIC_API_KEY=...            # or OPENAI_API_KEY
pnpm agon run examples/demo-app/agon.yaml -n 10 -c 2
```

Each simulated user gets a persona, opens the app in a headless browser, and works toward the scenario goal while the engine records every step, intercepts the app's own PostHog events, and enforces step and dollar budgets. Add `--headful` to watch. Output lands in `./agon-out/<runId>/`.

## 5. Analyze and inspect

```sh
pnpm agon compare ./agon-out             # newest run → result.json + verdict
pnpm agon trace   ./agon-out             # list sessions
pnpm agon trace   ./agon-out 3           # replay session #3 step by step
```

`compare` always prints the calibration note next to the numbers. Until a calibration profile has been fitted on real outcomes, every result is a forecast with unknown direction accuracy, not a measurement.

## Replaying without a model

`--llm-mode record` stores every model response under `.agon/llm-cache`; `--llm-mode replay` serves them back with zero cost, which is how CI and demos run deterministically.

## Exporting

Add sinks to `export:` in `agon.yaml`. `jsonl` and `parquet` write local tables; `posthog` sends marked events with `$feature/<experimentKey>` so PostHog Experiments reads them natively; `amplitude` uses the HTTP v2 API. Every exported event carries `agon_simulated: true`.
