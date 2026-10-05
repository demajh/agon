# @agon/server

The Agon control plane: a Hono API described by OpenAPI 3.1, a pg-boss worker that runs
experiments, API-key auth, the squad control protocol, a minimal policy engine and outbound
webhooks. Everything persists through `@agon/db`; the only other state is the data directory
(screenshots, `sessions.jsonl`, `result.json`, file exports).

```
pnpm -F @agon/server dev          # tsx watch src/main.ts
pnpm -F @agon/server start        # node dist/main.js (after pnpm build)
docker compose up -d              # Postgres + server (+ demo app) from the repo root
```

Interactive docs at `http://localhost:4000/docs`, the document itself at `/openapi.json`.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string; migrated on start. pg-boss uses the same database, schema `pgboss`. |
| `PORT` | `4000` | HTTP port (`HOST` defaults to `0.0.0.0`). |
| `AGON_API_KEYS` | none | Bootstrap keys, `key:role[:squadSlug]` comma-separated; checked before the `api_keys` table. Keys are at least 16 characters; squad keys name their squad. |
| `AGON_ROLE` | `all` | `all` (API + worker), `api` (only serve), `worker` (only run jobs). |
| `AGON_DATA_DIR` | `.agon/data` | Screenshots `<dir>/screenshots/<runId>/<stepId>.png`, `<dir>/runs/<runId>/{sessions.jsonl,result.json}`, relative `export:` file sinks under `<dir>/exports`. |
| `AGON_LLM_MODE` | `live` | `live`, `record`, `replay` or `off` for `@agon/llm` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` as usual). |
| `AGON_WEBHOOK_URL` | none | Receives `{ event, timestamp, data }` for `run.completed`, `result.ready`, `decision.proposed`, `decision.made` (5 s timeout, failures logged). |
| `AGON_LOG_LEVEL` | `info` | pino level. |
| `AGON_CONCURRENCY` | config | Sessions in parallel per run (overrides `defaults.maxConcurrency`). |
| `AGON_QUEUE_SCHEMA` | `pgboss` | Schema for pg-boss tables. |
| `AGON_STATS_BIN` | auto | How to run `agon-stats`; otherwise `agon-stats` on PATH, then `uv run --project packages/stats`. |

## Auth

`Authorization: Bearer <key>`. Roles: `observer` may only read; `operator` may do everything;
`squad` may read and register variants credited to its own squad. `/healthz`, `/openapi.json` and
`/docs` need no key. Errors are `{ error: { code, message, details? } }` with the spec's stable codes
(`validation_error`, `config_error`, `not_found`, `conflict`, `unauthorized`, `forbidden`,
`internal_error`).

## Routes (all under `/v1` except the meta routes)

| Method and path | Purpose |
| --- | --- |
| `GET /healthz`, `GET /openapi.json`, `GET /docs` | Liveness, the OpenAPI document, the API reference. |
| `POST /v1/environments` | Store an `agon.yaml` as JSON `{ name?, config }` or YAML text (`Content-Type: application/yaml`). `${...}` placeholders are rejected, never expanded. |
| `GET /v1/environments`, `GET/PUT/DELETE /v1/environments/{id}` | List (cursor paginated), read, replace, delete. |
| `POST /v1/environments/{id}/validate` | `{ ok, issues[] }` for a candidate config (JSON or YAML). |
| `POST /v1/environments/{id}/variants`, `GET …/variants` | Upsert a variant and merge it into `target.variants`; list. |
| `POST /v1/environments/{id}/runs`, `GET …/runs` | Queue a run (`variants`, `seed`, `size`, `model`, `dryRun`); list with `status` filter. |
| `GET /v1/runs/{id}`, `POST /v1/runs/{id}/cancel` | Read; cancel (queued runs immediately, running runs between sessions). |
| `GET /v1/runs/{id}/results` | The `Result`; 404 until the run completed and was analyzed. |
| `GET /v1/runs/{id}/sessions`, `GET /v1/sessions/{id}`, `GET /v1/sessions/{id}/trace` | Sessions (`variant`, `status` filters); one session; session with steps and events. |
| `GET /v1/runs/{id}/screenshots/{stepId}` | PNG from the data directory. |
| `GET /v1/personas` | The built-in persona library. |
| `POST/GET /v1/squads`, `GET/PATCH /v1/squads/{id}` | Squad registry. |
| `GET /v1/squads/leaderboard` | Ranked by win rate, then mean lift, with allocation. |
| `POST /v1/squads/{id}/pause\|resume\|kill` | `{ reason, approval? }`: a Decision row first, then status, then the control webhook. `approval: human` only proposes. |
| `POST /v1/squads/reallocate` | Thompson allocation over active squads (`floor`, default 0.1) through one `reallocate` Decision. |
| `GET /v1/decisions`, `GET /v1/decisions/{id}` | The append-only log (`squadId`, `status`, `kind`, `policyId`, `actor` filters). |
| `POST /v1/decisions/{id}/approve\|reject` | Execute or decline a proposed decision. |
| `POST/GET /v1/api-keys`, `DELETE /v1/api-keys/{id}` | Operators only; the plaintext key is returned once. |

## Run lifecycle

`POST …/runs` creates the run (`queued`, config snapshot with `size`/`model` applied) and enqueues
`agon.run { runId }`. The worker sets `running`, builds the model client and a Chromium per run,
records to Postgres (plus live `counts`/`costUsd`), screenshots and the config's exporters, and
polls the run row every 2 s so a cancel aborts between sessions. When the engine finishes, the
worker writes `sessions.jsonl`, runs `agon-stats analyze`, and stores Result and run together,
so `status: completed` means the result is available (or `error` says why not). Then squad scores
are updated for every squad credited in `target.variants[*].squad` (win: the result ships its
variant; loss: a kill or somebody else's ship), policies run, and webhooks fire.

## Policies

`policies[]` in the config are evaluated on `result.ready` and `run.completed`. `when` is a safe
expression, no `eval`:

```
expr   := term ('or' term)*          term := factor ('and' factor)*
factor := '(' expr ')' | variable op value
op     := < <= > >= == !=            value := number | 'string' | bareword
```

Variables: `result.verdict`, `result.p_best`, `result.lift` (primary metric, best treatment),
`squad.win_rate`, `squad.runs`, `squad.mean_lift`, `squad.p_best_rolling(N)` (mean P(best) of the
squad's last N results). Squad policies run once per credited squad; `reallocate` runs once per run
with the policy `floor`. `pause` and `kill` default to `approval: human` (a `proposed` Decision and a
`decision.proposed` webhook); everything else executes immediately. `cooldown` skips when a decision
of the same kind for the same squad exists within the window; `maxPerDay` caps them per 24 h.

## Tests

`pnpm -F @agon/server test` needs Postgres (`docker compose up -d postgres`) and creates its own
`agon_server_test` database. The run lifecycle test uses the real `agon-stats` through `uv` when
available; set `AGON_SKIP_STATS_TESTS=1` to stub it, `AGON_SKIP_DB_TESTS=1` to skip everything that
needs the database.
