# syntax=docker/dockerfile:1.7
# Multi-stage build: one image, three entrypoints (api, worker, migrate). Pin the base by digest before release.
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /srv

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
COPY packages/storage/package.json packages/storage/
COPY packages/security/package.json packages/security/
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG INCLUDE_CLI=true
COPY . .
RUN pnpm build:server && if [ "$INCLUDE_CLI" = "true" ]; then pnpm build:cli; fi

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /srv /srv
# the fs storage mount point must be writable by the unprivileged runtime user
RUN mkdir -p /data/storage && chown -R node:node /data /srv
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
