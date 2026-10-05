# Agon — operating manual for coding agents

Agon runs simulated users (LLM agents with personas) against variants of a software product, records every session, analyzes the sessions as an experiment, and governs the agentic squads that produced the variants. PLAN.md holds the full design and roadmap. This file holds the rules every change must follow.

## Repo map

| Path | Purpose |
|---|---|
| `packages/spec` | Zod schemas: domain model, `agon.yaml`, events, policies, adapter/LLM interfaces. **Source of truth for all types.** Exports JSON Schema. |
| `packages/db` | Drizzle schema, migrations, repository functions. **The only package that touches SQL.** |
| `packages/llm` | Provider-agnostic LLM client: structured output, model routing, cost accounting, record/replay cache. **The only package that calls a model provider.** |
| `packages/adapters` | Target adapters (web via Playwright; later http, cli, mcp). Implement the `Adapter` interface from `@agon/spec`. |
| `packages/engine` | Orchestrator, session loop, persona/population sampling, simulated-user agent, recorder interface, judge. |
| `packages/exporters` | Sinks: JSONL/Parquet, PostHog, Amplitude, warehouse. |
| `packages/server` | Hono API (OpenAPI), pg-boss workers, API-key auth, policy engine, outbound webhooks. |
| `packages/sdk` | TypeScript client generated from the server's OpenAPI document plus a thin wrapper. `generated/` is never hand-edited. |
| `packages/cli` | `agon` CLI. Local mode runs the engine in-process; remote mode talks to a server through `@agon/sdk`. |
| `packages/stats` | `agon-stats` (Python, uv): analysis, bandit allocation, calibration. Invoked as a subprocess with JSON/JSONL/Parquet I/O. |
| `examples/demo-app` | Two-variant onboarding app used by tests and the quickstart. |
| `personas/` | Built-in persona library (YAML). |
| `bench/` | Calibration harness and sim-vs-real datasets. |
| `deploy/` | Dockerfiles. `compose.yaml` at the root is the self-host entry point. |
| `ee/` | Commercial features, separately licensed. Empty in open source. |

## Commands

```
pnpm install                      install and link all workspace packages
pnpm build | typecheck | test     via turbo, in dependency order (tests run against built deps)
pnpm -F @agon/<pkg> test          one package
pnpm check:deps                   dependency-direction check (CI runs it)
pnpm generate                     re-export OpenAPI and regenerate the SDK
cd packages/stats && uv run pytest
docker compose up -d              Postgres + MinIO (+ app services as they land)
```

## Invariants

CI enforces most of these. Do not work around them.

1. **Dependency direction is fixed.** `scripts/check-deps.mjs` holds the allow-list. `spec` depends on nothing internal; `engine` may use `spec`, `llm`, `adapters`; `server` and `cli` sit above; `ui` sees only `sdk`.
2. **Only `@agon/db` contains SQL or Drizzle schema.** Everything else calls its repository functions.
3. **Only `@agon/llm` calls a model provider.** Engine, server, and CLI receive an `LlmClient`.
4. **Every API change updates, in the same commit:** the Zod route schemas, the committed OpenAPI document, the generated SDK, and docs.
5. **Every emitted event carries** `agon_simulated: true`, `agon_run_id`, `agon_variant`, `agon_persona`, `agon_model`. Exporters refuse events without them.
6. **No destructive squad action** (pause, kill, reallocate) without a `Decision` row written first.
7. **Results are forecasts.** Any surface that shows a lift or p-value shows the calibration note next to it.
8. **Determinism.** Every random choice flows from the run seed through a seeded RNG (`pure-rand`). No `Math.random` in `engine`, `stats`, or `adapters`. Tests use the replay LLM provider; CI never calls a live model.
9. **Cost is accounted.** Every LLM call records tokens and USD on its session. Budgets are hard stops.

## Code conventions

- TypeScript strict, ESM only (`"type": "module"`), `NodeNext` resolution: **relative imports end in `.js`**, type-only imports use `import type`.
- Node >= 22. No `any`; use `unknown` and parse with Zod at boundaries.
- Errors: throw subclasses of `AgonError` from `@agon/spec` with a stable `code`.
- Logging: `pino`, structured. No `console.log` outside `packages/cli`.
- Tests: vitest, colocated `*.test.ts`; pytest for `stats`. Fixtures under `__fixtures__/`. Tests must not need network access or API keys.
- Build: `tsc -p tsconfig.build.json` to `dist/`. No bundler for libraries.
- Generated files live in `generated/` and are committed. Regenerate with `pnpm generate`; never edit by hand.
- Python (`packages/stats`): `uv`, `ruff`, type hints everywhere, `pytest`.

## Git

- Conventional Commits: `feat(engine): ...`, `fix(server): ...`, `docs: ...`, `chore: ...`.
- **No AI attribution in commits or PRs.** No `Co-Authored-By` trailers, no "Generated with" footers. Author is the repo's configured identity.
- Commit after each coherent unit of work and push to `origin main`.

## Adding a package

1. Create `packages/<name>` with `package.json` (`@agon/<name>`, `"type": "module"`, scripts `build`/`typecheck`/`test`/`clean` copied from an existing package), `tsconfig.json` and `tsconfig.build.json` copied from an existing package, `src/index.ts`.
2. Register the package and its allowed internal dependencies in `scripts/check-deps.mjs`.
3. Use `catalog:` versions from `pnpm-workspace.yaml` for shared dependencies.
