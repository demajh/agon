# @agon/cli

The `agon` command.

```
agon validate [agon.yaml]                 validate a config and summarize it
agon plan [agon.yaml] [-n N] [-s S]       show the sessions a run would execute (no browser, no model)
agon run [agon.yaml] [options]            simulate the population against every variant and record the run
agon compare <dir> [options]              analyze a run with agon-stats and write result.json next to it
agon trace <dir> [session]                list a run's sessions, or replay one step by step
agon personas [list|show <id>]            browse the built-in persona library
agon schema                               JSON Schema for agon.yaml (editor support)
```

`agon run` writes `<out>/<runId>/` (default `./agon-out`): `run.json`, `sessions.jsonl`, `steps.jsonl`, `events.jsonl`, `manifest.json`, `screenshots/`, plus whatever `export:` sinks the config lists. Useful flags: `-n` size, `-s` seed, `-v` variants, `-m` model, `-c` concurrency, `--llm-mode record|replay` (fixtures in `.agon/llm-cache`), `--headful`, `--dry-run`.

Provider keys come from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (or `OPENAI_COMPATIBLE_BASE_URL` for local models). Global flags: `--json`, `--no-color`.

`agon compare` needs the Python `agon-stats` engine: `AGON_STATS_BIN`, `agon-stats` on PATH, or `uv` inside a checkout.
