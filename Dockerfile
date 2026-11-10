# Base images are pinned by digest and updated by Dependabot.
# Phase 4 replaces the runtime stage with a distroless image.

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS base
ENV PNPM_HOME=/pnpm \
    PNPM_CONFIG_STORE_DIR=/pnpm/store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    HUSKY=0
# pnpm version and integrity come from the packageManager field.
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
# No lifecycle scripts: production dependencies need none, and the root
# `prepare` script (husky) is a development tool.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Application files stay owned by root: the runtime user can read, not modify, them.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
