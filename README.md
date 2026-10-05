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
