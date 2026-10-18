# syntax=docker/dockerfile:1
#
# The CRM's image, built for Coolify. ROLE chooses what runs:
#   app     the API and the dashboard
#   worker  background work
#   all     both, for development and tiny installs
# Configuration is read at start; see apps/server/README.md.

# Node 24, the version in .nvmrc, pinned by digest so every build starts from the same image.
FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack provides the pnpm version pinned in package.json's packageManager field.
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Coolify passes NODE_ENV=production to every build stage, and the build needs the
# development dependencies (TypeScript, Vite). Production comes back in the final stage.
ENV NODE_ENV=development
# No git hooks to install inside an image.
ENV LEFTHOOK=0
# Downloads every package from the lockfile alone, so this layer is reused until the
# lockfile changes, whatever else does.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm-workspace.yaml names these patches, and pnpm reads them before it fetches anything.
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store
# The server with the packages it uses, and the dashboard (which checks its size budgets).
RUN pnpm exec turbo run build --filter=@repo/server... --filter=@repo/dashboard
# The server and its production dependencies only, workspace packages included.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @repo/server --prod deploy /out/server --store-dir /pnpm/store

# The server and the dashboard: the default and last target. The database is not part of
# an install's images: it is an external PostgreSQL 18 with pgvector (compose.yml).
FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
# tini runs as PID 1: it passes Docker's SIGTERM on to Node and reaps zombie processes.
# apk upgrade takes Alpine's security fixes as they're released, between base image updates.
# npm, npx, corepack and yarn ship with the base image but never run here, and npm's own
# dependencies were most of what a scan of the image found.
RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/server ./
COPY --from=build --chown=node:node /repo/apps/dashboard/dist ./dashboard
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DASHBOARD_DIR=/app/dashboard
# Where the Compose file keeps uploaded files (FILES_DIR). A new volume mounted here takes
# this folder's owner, so the server, which doesn't run as root, can write to it.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
# 127.0.0.1, not localhost: busybox wget resolves localhost to ::1, and the server listens
# on IPv4. Every role answers /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q --spider "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
