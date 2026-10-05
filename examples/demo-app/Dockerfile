# syntax=docker/dockerfile:1
# Ledgerly, the Agon demo target. The build context MUST be the repository root, because the
# lockfile and the workspace manifest live there:
#
#   docker build -f examples/demo-app/Dockerfile -t agon-demo-app .
#   docker run --rm -p 3001:3000 -e VARIANT=control   agon-demo-app
#   docker run --rm -p 3002:3000 -e VARIANT=treatment agon-demo-app
#
# Environment: VARIANT (control|treatment), PORT (3000), POSTHOG_HOST, POSTHOG_KEY.

ARG NODE_IMAGE=node:22-alpine

# --- base: pnpm plus the manifests needed to resolve @agon/demo-app from the shared lockfile ---
FROM ${NODE_IMAGE} AS base
RUN npm install --global --silent pnpm@12.6.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY examples/demo-app/package.json examples/demo-app/

# --- build: dev dependencies, TypeScript -> dist ------------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile --filter @agon/demo-app
COPY examples/demo-app/tsconfig.json examples/demo-app/tsconfig.build.json examples/demo-app/
COPY examples/demo-app/src examples/demo-app/src
RUN pnpm --filter @agon/demo-app build

# --- prod-deps: runtime dependencies only -------------------------------------------------------
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @agon/demo-app

# --- runtime ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000 VARIANT=control
# Keep the workspace layout: the package's node_modules symlink into /repo/node_modules/.pnpm.
WORKDIR /repo/examples/demo-app
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/examples/demo-app/node_modules ./node_modules
COPY --from=build /repo/examples/demo-app/dist ./dist
COPY examples/demo-app/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
