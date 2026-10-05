# Agon

Simulated-user A/B testing and agentic-squad governance for AI-generated software.

Agon spins up simulation environments in which LLM-driven users with realistic personas work through variants of your product. It records every session, analyzes the sessions as an experiment, exports the results to the analytics stack you already use (PostHog, Amplitude, your warehouse), and governs the agentic development squads that produced the variants: scoring them, re-allocating work between them, and pausing or killing the ones that lose.

**Status:** pre-alpha, under active construction. The design and roadmap are in [PLAN.md](PLAN.md).

## Layout

```
packages/spec        domain model and agon.yaml schema (Zod, source of truth)
packages/db          Postgres schema and migrations (Drizzle)
packages/llm         provider-agnostic LLM client with record/replay
packages/adapters    target adapters (web via Playwright; http, cli, mcp later)
packages/engine      orchestrator, session loop, personas, simulated-user agent, judge
packages/exporters   JSONL/Parquet, PostHog, Amplitude, warehouse sinks
packages/server      API (OpenAPI), workers, policy engine
packages/sdk         generated TypeScript client
packages/cli         the `agon` command
packages/stats       agon-stats (Python): analysis, bandits, calibration
examples/demo-app    two-variant demo target used by tests and the quickstart
personas/            built-in persona library
bench/               calibration harness
```

## Try it

```
pnpm install && pnpm build && uv sync --project packages/stats
VARIANT=control   PORT=3001 pnpm -F @agon/demo-app dev &
VARIANT=treatment PORT=3002 pnpm -F @agon/demo-app dev &
export ANTHROPIC_API_KEY=...
pnpm agon run examples/demo-app/agon.yaml -n 10
pnpm agon compare ./agon-out
```

Step-by-step walkthrough in [docs/quickstart.md](docs/quickstart.md); the `agon.yaml` reference is in [docs/agon-yaml.md](docs/agon-yaml.md).

## Development

Requires Node >= 22, pnpm, uv, and Docker.

```
pnpm install
docker compose up -d        # Postgres + MinIO
pnpm build && pnpm test
```

See [CLAUDE.md](CLAUDE.md) for the rules every change follows.

## License

Apache-2.0. See [LICENSE](LICENSE). The `ee/` directory is reserved for separately licensed commercial features and is empty in this distribution.
