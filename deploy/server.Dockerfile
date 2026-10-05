# syntax=docker/dockerfile:1
# Agon control-plane server: API + pg-boss worker, with Chromium (Playwright) and agon-stats.
#
# The build context MUST be the repository root (the lockfile, the workspace manifest and every
# workspace package live there):
#
#   docker build -f deploy/server.Dockerfile -t agon-server .
#   docker run --rm -p 4000:4000 \
#     -e DATABASE_URL=postgres://agon:agon@host.docker.internal:5432/agon \
#     -e AGON_API_KEYS=dev-operator-key:operator agon-server
#
# Environment: DATABASE_URL (required), PORT (4000), AGON_API_KEYS, AGON_ROLE (all|api|worker),
# AGON_DATA_DIR (/data), AGON_LLM_MODE, AGON_WEBHOOK_URL, AGON_LOG_LEVEL, ANTHROPIC_API_KEY /
# OPENAI_API_KEY for live models. See packages/server/README.md.

# Playwright's image carries Node 22 and the Chromium build matching the `playwright` package.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
FROM ${PLAYWRIGHT_IMAGE}

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/bin:$PATH \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    AGON_DATA_DIR=/data \
    PORT=4000

# uv, then agon-stats as a tool: its own Python 3.12 environment under /opt/uv (readable by the
# unprivileged runtime user) and an `agon-stats` shim on PATH.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
WORKDIR /repo
COPY packages/stats/pyproject.toml packages/stats/README.md packages/stats/
COPY packages/stats/src packages/stats/src
RUN uv tool install --python 3.12 /repo/packages/stats \
  && chmod -R a+rX /opt/uv \
  && agon-stats --version

# pnpm, pinned to the version package.json declares.
RUN npm install --global --silent pnpm@12.6.0

# Manifests first so dependency installation is cached independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/adapters/package.json packages/adapters/
COPY packages/engine/package.json packages/engine/
COPY packages/exporters/package.json packages/exporters/
COPY packages/stats-client/package.json packages/stats-client/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY examples/demo-app/package.json examples/demo-app/
RUN pnpm install --frozen-lockfile

# Sources (listed explicitly so host node_modules and dist never enter the image), then build the
# server and every workspace package it depends on, in dependency order.
COPY personas personas
COPY packages/spec/tsconfig.json packages/spec/tsconfig.build.json packages/spec/
COPY packages/spec/src packages/spec/src
COPY packages/db/tsconfig.json packages/db/tsconfig.build.json packages/db/
COPY packages/db/src packages/db/src
COPY packages/db/drizzle packages/db/drizzle
COPY packages/llm/tsconfig.json packages/llm/tsconfig.build.json packages/llm/
COPY packages/llm/src packages/llm/src
COPY packages/adapters/tsconfig.json packages/adapters/tsconfig.build.json packages/adapters/
COPY packages/adapters/src packages/adapters/src
COPY packages/engine/tsconfig.json packages/engine/tsconfig.build.json packages/engine/
COPY packages/engine/src packages/engine/src
COPY packages/engine/scripts packages/engine/scripts
COPY packages/exporters/tsconfig.json packages/exporters/tsconfig.build.json packages/exporters/
COPY packages/exporters/src packages/exporters/src
COPY packages/stats-client/tsconfig.json packages/stats-client/tsconfig.build.json packages/stats-client/
COPY packages/stats-client/src packages/stats-client/src
COPY packages/server/tsconfig.json packages/server/tsconfig.build.json packages/server/
COPY packages/server/src packages/server/src
RUN pnpm --filter @agon/server... build && pnpm store prune

RUN mkdir -p /data && chown pwuser:pwuser /data
VOLUME ["/data"]
USER pwuser
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
