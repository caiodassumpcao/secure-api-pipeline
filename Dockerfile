# Base images are pinned by digest and updated by Dependabot.
#
# The Node.js stages run on the build machine's platform: compiled JavaScript
# does not depend on the target, and production dependencies are installed
# for the target explicitly. The runtime stage only copies files, so
# linux/amd64 and linux/arm64 build on one machine without emulation
# (ADR-0007).

FROM --platform=$BUILDPLATFORM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
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
ARG TARGETARCH
# Dependencies for the runtime, not for this Alpine (musl) stage: glibc and
# the target CPU, so native modules such as @node-rs/argon2 get the binary the
# distroless image can load. No lifecycle scripts: production dependencies
# need none, and the root `prepare` script (husky) is a development tool.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    case "$TARGETARCH" in \
      amd64) cpu=x64 ;; \
      arm64) cpu=arm64 ;; \
      *) echo "unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && pnpm install --frozen-lockfile --prod --ignore-scripts --os linux --cpu "$cpu" --libc glibc

# Node.js and glibc only: no shell, no package manager, uid 65532.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:39b0407357c9fadf1a9708d22088f02de21f0e1e8a688474eea2d8701e7d5693 AS runtime
# The metrics port listens inside the Docker network only: it is never
# published (compose.yaml) nor routed by the proxy.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    METRICS_HOST=0.0.0.0 \
    METRICS_PORT=9464
WORKDIR /app
# Application files stay owned by root: the runtime user can read, not modify, them.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# SQL migrations, applied by `dist/migrate.js`; the journal also tells the
# readiness probe which schema this build expects.
COPY drizzle ./drizzle
USER 65532:65532
EXPOSE 3000
# The health check and the migrations run without the telemetry preload.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/nodejs/bin/node", "dist/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node"]
# The telemetry preload must run before the app imports anything (ADR-0006).
CMD ["--import", "./dist/telemetry/instrument.js", "dist/main.js"]
