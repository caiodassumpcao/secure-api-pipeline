# secure-api-pipeline — Design Specification

> Status: **Draft v1** · Owner: Caio Dassumpção Rodrigues
> Technical source of truth. Any behavior change must update this document (or add an ADR) in the same pull request.

---

## 1. Purpose

A **production-grade reference** for building, securing, shipping and operating a Node.js API. The API is intentionally small; the engineering around it is the product:

- Secure-by-default application code (authentication, authorization, tenant isolation, input validation, audit).
- A **DevSecOps pipeline** covering SAST, SCA, secrets, IaC/container scanning, SBOM, signed images, build provenance and DAST.
- **Gated, verifiable deployments** with automatic rollback.
- **Observability from day one** (OpenTelemetry traces, metrics and correlated logs), ready to plug into `observability-stack`.

### 1.1 Goals

- Show how a Tech Lead structures a service: architecture, decisions (ADRs), threat model, quality gates, governance.
- Every security control is **automated and visible** (CI checks, badges, reports), not just described.
- Fully reproducible locally with Docker Compose.

### 1.2 Non-goals

- Feature-rich product, front-end, multi-region, Kubernetes.
- Third-party identity providers (OIDC login) in v1 — documented as future work.

### 1.3 Ecosystem

| Repository                       | Role                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `server-hardening-kit`           | Hardens the VPS this API is deployed to                    |
| `drkit`                          | Backs up and recovers the API (database, secrets, compose) |
| `observability-stack` _(future)_ | Consumes the API's OTLP telemetry and `/metrics`           |

---

## 2. Domain

Multi-tenant **project & task tracker** — small enough to stay focused, rich enough to exercise real authorization.

| Entity                   | Fields (main)                                                                                                        | Notes                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `users`                  | id (uuid v7), email (unique, citext), password_hash, name, created_at, locked_until, failed_login_attempts           | Lockout applies to clients without a device cookie (ADR-0009)                |
| `workspaces`             | id, name, slug, created_at                                                                                           | Tenant boundary                                                              |
| `memberships`            | workspace_id, user_id, role, created_at                                                                              | Role: `owner` · `admin` · `member` · `viewer`                                |
| `invitations`            | id, workspace_id, role, email?, token_hash, invited_by, created_at, expires_at, accepted_by, accepted_at, revoked_at | Single-use link, 7 days (ADR-0010)                                           |
| `projects`               | id, workspace_id, name, archived_at, created_at                                                                      | Archived projects keep their tasks, read-only                                |
| `tasks`                  | id, workspace_id, project_id, title, description, status, priority, assignee_id, due_date, created_by, timestamps    | Status: `todo` · `in_progress` · `done`; priority: `low` · `medium` · `high` |
| `refresh_token_families` | id, user_id, created_at, expires_at, revoked_at, revoked_reason                                                      | One session: 30-day absolute lifetime; revoked on logout or reuse (ADR-0004) |
| `refresh_tokens`         | id, family_id, token_hash, created_at, expires_at, replaced_by, rotated_at                                           | Rotation + reuse detection; 7-day idle lifetime                              |
| `trusted_devices`        | id, user_id, token_hash, created_at, last_used_at, expires_at, failed_attempts, revoked_at                           | Device cookies, 90 days (ADR-0009)                                           |
| `audit_events`           | id, workspace_id?, actor_id?, action, target, ip (inet), user_agent, metadata (jsonb), created_at                    | Append-only (trigger), no foreign keys, 365 days                             |
| `rate_limits`            | key (hashed), hits, reset_at                                                                                         | `UNLOGGED`; fixed windows shared by every instance                           |

Opaque secrets (refresh tokens, device cookies, invitation links) are 256 random bits stored only as their SHA-256.

`workspace_id` is denormalized on `tasks` to make tenant filters mandatory and cheap. Composite foreign keys keep it consistent: `(workspace_id, project_id)` references `projects (workspace_id, id)` and `(workspace_id, assignee_id)` references `memberships (workspace_id, user_id)`, so the database itself rejects a task that points to a project or an assignee of another workspace (ADR-0005).

Primary keys are UUID v7 generated by the application: time-ordered (strictly increasing within a process, even if the system clock steps back), they double as the key of cursor pagination and do not reveal row counts.

### 2.1 Permission matrix

| Action                                | owner |      admin      |  member  | viewer |
| ------------------------------------- | :---: | :-------------: | :------: | :----: |
| Read workspace and members            |  ✅   |       ✅        |    ✅    |   ✅   |
| Read projects/tasks                   |  ✅   |       ✅        |    ✅    |   ✅   |
| Create/update tasks                   |  ✅   |       ✅        |    ✅    |   ❌   |
| Delete tasks                          |  ✅   |       ✅        | own only |   ❌   |
| Create/rename/archive projects        |  ✅   |       ✅        |    ❌    |   ❌   |
| Update workspace (name, slug)         |  ✅   |       ✅        |    ❌    |   ❌   |
| Manage members and invitations        |  ✅   | ✅ (not owners) |    ❌    |   ❌   |
| Delete workspace / transfer ownership |  ✅   |       ❌        |    ❌    |   ❌   |
| Read audit log                        |  ✅   |       ✅        |    ❌    |   ❌   |

The matrix is encoded once (`src/modules/auth/permissions.ts`) and covered by a **table-driven authorization test** that exercises every cell over HTTP.

Rules enforced by the services:

- A caller who is not a member of the workspace gets **404** for the workspace and everything in it, exactly as if it did not exist; a member whose role lacks the permission gets **403**.
- Granting the `owner` role is how ownership is transferred; only owners grant, change or revoke it. A workspace always keeps at least one owner: membership changes lock the workspace row, so concurrent requests cannot both remove "the other" owner.
- Members join through invitation links accepted by the invitee (ADR-0010); only owners invite or revoke owners. Removing a member unassigns their tasks in the same transaction.
- Archiving a project (`DELETE`) is idempotent and freezes its tasks: they stay readable, while creating, updating or deleting them answers 409.

---

## 3. API

Base path `/v1`. JSON only. Errors follow **RFC 9457** (`application/problem+json`) with `type`, `title`, `status`, `detail`, `instance`, `traceId`. Validation errors include `errors[]` with field paths. Never leak stack traces or SQL.

| Method           | Path                                             | Auth   | Description                                                    |
| ---------------- | ------------------------------------------------ | ------ | -------------------------------------------------------------- |
| POST             | `/v1/auth/register`                              | —      | Create account (+ personal workspace it owns)                  |
| POST             | `/v1/auth/login`                                 | —      | Returns access token; sets refresh and device cookies          |
| POST             | `/v1/auth/refresh`                               | cookie | Rotates the refresh token; reuse revokes the session           |
| POST             | `/v1/auth/logout`                                | cookie | Revokes the session; always 204                                |
| GET              | `/v1/me`                                         | ✅     | Current user + memberships (up to 100)                         |
| GET/POST         | `/v1/workspaces`                                 | ✅     | List / create                                                  |
| GET/PATCH/DELETE | `/v1/workspaces/:wsId`                           | ✅     |                                                                |
| GET/PATCH/DELETE | `/v1/workspaces/:wsId/members[/:userId]`         | ✅     | Change role; remove                                            |
| GET/POST         | `/v1/workspaces/:wsId/invitations`               | ✅     | Pending invitations / create a single-use link                 |
| DELETE           | `/v1/workspaces/:wsId/invitations/:invitationId` | ✅     | Revoke                                                         |
| POST             | `/v1/invitations/accept`                         | ✅     | Join the workspace of a link                                   |
| GET/POST         | `/v1/workspaces/:wsId/projects`                  | ✅     | Filter: `includeArchived`; cursor pagination                   |
| GET/PATCH/DELETE | `/v1/workspaces/:wsId/projects/:projectId`       | ✅     | Rename; `DELETE` archives                                      |
| GET/POST         | `/v1/workspaces/:wsId/projects/:projectId/tasks` | ✅     | Filters: `status`, `priority`, `assigneeId`; cursor pagination |
| GET/PATCH/DELETE | `/v1/workspaces/:wsId/tasks/:taskId`             | ✅     |                                                                |
| GET              | `/v1/workspaces/:wsId/audit-events`              | ✅     | Newest first; filter: `action`; cursor pagination              |
| GET              | `/health/live`, `/health/ready`                  | —      | Liveness / readiness (DB ping; applied migrations)             |
| GET              | `/docs`, `/openapi.json`                         | —      | Disabled in production unless `API_DOCS_ENABLED=true`          |

`/metrics` is served on a **separate internal port** (`METRICS_PORT`, default 9464), never through the public proxy.

Authentication (ADR-0004): `/v1` routes take an access token in `Authorization: Bearer`; a rejected token gets `WWW-Authenticate: Bearer …, error="invalid_token"`. The refresh token travels only in the `__Secure-refresh` cookie, to `/v1/auth`; refresh and logout refuse cross-site requests (`Sec-Fetch-Site`, `Origin` outside the API's own and `CORS_ORIGINS`). Every response carries `Cache-Control: no-store` unless a route chose otherwise. Rate limits answer 429 with `Retry-After` (ADR-0009).

Pagination: `?limit=` (1–100, default 20) + opaque `?cursor=`; response `{ data: [], nextCursor }`.

---

## 4. Architecture

```
src/
├── main.ts                 # bootstrap: config → app → listen, graceful shutdown (telemetry preloaded)
├── healthcheck.ts          # container HEALTHCHECK probe (no shell in the runtime image)
├── app.ts                  # buildApp(): Fastify instance, plugins, routes (testable)
├── config/                 # env schema (zod), typed config
├── telemetry/              # OTel preload (node --import), instrumentations, span redaction, metrics
├── plugins/                # security headers, cors, rate limit, auth, error handler, request id
├── db/                     # drizzle client, schema, migrations, transaction helper
├── modules/
│   ├── health/             # liveness and readiness routes
│   ├── auth/               # routes, service, tokens, keys, password, cookies, permissions
│   ├── workspaces/
│   ├── members/
│   ├── invitations/
│   ├── projects/
│   ├── tasks/
│   └── audit/
├── jobs/                   # cleanup of expired rows (advisory lock, hourly)
├── lib/                    # problem details, pagination, ids, opaque tokens, rate limiter
└── types/
```

Each module: `*.routes.ts` (HTTP + zod schemas) → `*.service.ts` (business rules, authorization) → `*.repository.ts` (SQL, **always scoped by workspace_id**). Services receive the database explicitly (no global singletons) and build their repositories from it, or from an open transaction, so a multi-step change (removing a member and unassigning their tasks) commits atomically.

### 4.1 Technology decisions

| Concern          | Choice                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | Node.js 24 LTS. `pnpm dev` runs the TypeScript sources directly with Node's built-in type stripping (`node --watch`), so no transpiler dependency; `tsc` builds `dist/`                                                                                                                                                                                       |
| Language         | TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`, ESM, `erasableSyntaxOnly`). Held below 6.1 until typescript-eslint supports newer releases                                                                                                                                                                                                              |
| Package manager  | pnpm 12 via corepack (version + sha512 pinned in `packageManager`), lockfile committed, `--frozen-lockfile` in CI and image builds; supply-chain policy in `pnpm-workspace.yaml` (ADR-0003)                                                                                                                                                                   |
| HTTP             | Fastify 5 + `fastify-type-provider-zod`                                                                                                                                                                                                                                                                                                                       |
| Validation       | zod (request, response and env)                                                                                                                                                                                                                                                                                                                               |
| Database         | PostgreSQL 17                                                                                                                                                                                                                                                                                                                                                 |
| Data access      | Drizzle ORM + drizzle-kit SQL migrations (reviewed, committed)                                                                                                                                                                                                                                                                                                |
| Passwords        | argon2id (`@node-rs/argon2`): 19 MiB, 2 passes, 1 lane (OWASP baseline), parameters in the PHC string and rehash on login; NFKC, 12–128 characters, breached-password blocklist (NIST SP 800-63B)                                                                                                                                                             |
| Tokens           | `jose` — Ed25519 access JWT (`alg: Ed25519`, RFC 9864; `typ: at+jwt`), 15 min, `kid` = RFC 7638 thumbprint, previous public key accepted during rotations; opaque refresh token (256-bit) stored as SHA-256 in rotating families, 7 days idle / 30 days absolute, `__Secure-refresh` cookie (`HttpOnly; Secure; SameSite=Strict`, path `/v1/auth`) (ADR-0004) |
| Security plugins | `@fastify/helmet`, `@fastify/cors` (allowlist), `@fastify/rate-limit`, `@fastify/cookie`                                                                                                                                                                                                                                                                      |
| Logging          | pino (JSON), redaction of auth headers, cookies, passwords and tokens (up to 3 levels deep), sensitive query parameters masked in logged URLs                                                                                                                                                                                                                 |
| Telemetry        | OpenTelemetry Node SDK preloaded with `node --import`; explicit instrumentations (HTTP, `@fastify/otel`, pg, pino, Node runtime); OTLP/HTTP exporters for traces, metrics and logs; Prometheus exporter on an internal port (ADR-0006)                                                                                                                        |
| API docs         | `@fastify/swagger` generated from zod schemas                                                                                                                                                                                                                                                                                                                 |
| Tests            | Vitest, `app.inject()`, Testcontainers (PostgreSQL)                                                                                                                                                                                                                                                                                                           |
| Lint/format      | ESLint (flat config, typescript-eslint strict, `eslint-plugin-security`), Prettier                                                                                                                                                                                                                                                                            |
| Commits          | commitlint (Conventional Commits) on commits and PR titles, husky + lint-staged, Gitleaks in the pre-commit hook                                                                                                                                                                                                                                              |
| Releases         | release-please (versions, CHANGELOG, GitHub Releases)                                                                                                                                                                                                                                                                                                         |

---

## 5. Security design

### 5.1 Controls

| Threat                                   | Control                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing / brute force        | Rate limits per IP, per email and per user, shared by every instance (PostgreSQL); lockout after 10 failures for clients without a device cookie, so nobody can lock the owner out of a known device; identical 401 and argon2 cost for unknown, wrong and locked (ADR-0009) |
| Weak passwords                           | 12–128 characters after NFKC normalization, breached-password blocklist, nothing derived from the email; no composition rules (NIST SP 800-63B)                                                                                                                              |
| Token theft                              | 15-minute access JWT; refresh rotation with **reuse detection** (reuse of a rotated token revokes the whole family + audit event); tokens stored as SHA-256; logout revokes the family (ADR-0004)                                                                            |
| Broken object-level authorization (IDOR) | Every repository query requires `workspaceId`; membership + role checked in service layer; composite foreign keys; cross-tenant tests for every resource (ADR-0005)                                                                                                          |
| Account enumeration                      | Login failures answer alike; members join by invitation link, with no account lookup (ADR-0010); registration still discloses existing accounts (threat model RR-3)                                                                                                          |
| Mass assignment                          | Explicit zod input schemas (`.strict()`), response schemas strip unknown fields                                                                                                                                                                                              |
| Injection                                | Parameterized queries only (Drizzle); no raw SQL concatenation (ESLint rule + Semgrep)                                                                                                                                                                                       |
| XSS / clickjacking                       | Helmet: CSP `default-src 'none'` on the API (Swagger UI gets its own), `X-Content-Type-Options`, `frame-ancestors 'none'`; `Cache-Control: no-store`                                                                                                                         |
| CSRF on refresh cookie                   | `SameSite=Strict`, `__Secure-` cookie restricted to `/v1/auth`; refresh and logout refuse `Sec-Fetch-Site: cross-site` and foreign `Origin`s                                                                                                                                 |
| DoS                                      | Body limit (100 KB), connection/request timeouts, pagination caps, 600 requests/min per IP before routing, stricter limits on authentication; argon2 concurrency bounded by the libuv pool                                                                                   |
| Sensitive data in logs and telemetry     | pino redaction; spans without headers, bodies, query values, SQL parameters or error messages, and a redacting exporter; tests over full flows asserting secrets never appear in logs, exported spans, logs and metrics, or `/metrics` (ADR-0006)                            |
| Spoofed client IP                        | `X-Forwarded-For` trusted only from the proxies in `TRUST_PROXY` (hop count or CIDRs, never `true`)                                                                                                                                                                          |
| Forged trace context                     | Inbound `traceparent` ignored: clients cannot pick trace ids or force sampling (ADR-0006)                                                                                                                                                                                    |
| Secrets management                       | Config from env / Docker secrets files (`*_FILE`, JWT keys as files); app refuses to start with default or missing secrets in production, or with invalid signing keys                                                                                                       |
| Supply chain                             | Lockfile, `pnpm audit`, OSV-Scanner, Dependabot, pinned Actions by SHA, SBOM, signed images, provenance                                                                                                                                                                      |
| Container escape / privilege             | Distroless non-root image, read-only root FS, `no-new-privileges`, dropped capabilities                                                                                                                                                                                      |

### 5.2 Threat model

`docs/threat-model.md`: STRIDE per component (client → Nginx → API → PostgreSQL; CI/CD → GHCR → VPS), data-flow diagram (Mermaid), trust boundaries, assets, mitigations mapped to the table above, residual risks. Phase 1 starts it with the residual risks known so far; Phase 2 completes it.

### 5.3 Audit events

`auth.registered`, `auth.login.succeeded|failed`, `auth.locked`, `auth.refresh.reuse_detected`, `auth.logout`, `member.invited|added|removed|role_changed`, `invitation.revoked`, `project.archived`, `workspace.deleted`. Written in the same transaction as the change, with actor, workspace, target, client IP and user agent; metadata never holds secrets or the email of an unknown account. Repeating a change that changes nothing records nothing.

- **Append-only**: a trigger rejects `UPDATE` and `TRUNCATE`, and `DELETE` of rows younger than the retention period. No foreign keys, so events outlive what they describe.
- **Retention: 365 days.** The IP address and user agent are personal data: a year covers incidents discovered late and exceeds the six months the Marco Civil da Internet (art. 15) requires for access records, while staying bounded (LGPD art. 6). The hourly cleanup job, serialized across instances by an advisory lock, deletes older events in batches; the trigger enforces the same limit (`AUDIT_RETENTION_DAYS`, change both together).
- **Access**: `GET /v1/workspaces/:wsId/audit-events` for owners and admins; authentication events (no workspace) are not exposed by the API.
- The API's database role can still disable the trigger: separate migration and runtime roles are planned for Phase 5 (threat model RR-5).

---

## 6. Observability

OpenTelemetry, preloaded before the app (ADR-0006). Nothing a client sends as credentials, no request body and no email or name ever reaches telemetry; the security suite searches every exported signal for the secrets of a full flow.

| Signal  | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traces  | HTTP server span named after method and route template (`POST /v1/workspaces/:wsId/projects/:projectId/tasks`) → `@fastify/otel` request span → one span per service method (`tasks.create`) → `pg` query spans (parameterized statement, never parameter values). Attributes: `http.route`, status, `request.id`, `user.id`, `workspace.id` (opaque ids). Errors as `error.type`, never messages; only 5xx mark a span as failed. Health probes and API docs untraced |
| Metrics | `http.server.request.duration` (histogram by route template, method and status, never the raw URL; its count is the request count), `db.client.connection.count`/`max`/`pending_requests`, `db.client.operation.duration`, Node runtime (`nodejs.eventloop.*`, `v8js.*`), business counters `auth.login.failures{reason}`, `auth.token.reuse_detected`, `tasks.created`                                                                                                |
| Logs    | pino JSON on stdout with `trace_id`, `span_id`, `request_id`, `user_id` (no PII beyond ids); with an OTLP endpoint, the same records are sent over OTLP to Loki, trace context as structured fields. Collecting the API's stdout as well would duplicate every line                                                                                                                                                                                                    |
| Health  | `/health/live` (process), `/health/ready` (DB ping and applied migrations)                                                                                                                                                                                                                                                                                                                                                                                             |

- **Sampling**: parent-based trace-id ratio, default **0.1** (`OTEL_TRACES_SAMPLER_ARG`; `.env.example` keeps every trace in development). Unsampled requests still get span ids, so their logs carry a `trace_id`.
- **Trace context**: inbound `traceparent` is ignored; extraction may be enabled once the Phase 5 proxy sets it, trusting only that proxy (ADR-0006).
- **Export**: with `OTEL_EXPORTER_OTLP_ENDPOINT`, traces, metrics and logs are pushed over OTLP/HTTP, with bounded queues that drop data rather than slow requests. Without it nothing is pushed, and `/metrics` is still served.
- **`/metrics`**: Prometheus text on `METRICS_HOST:METRICS_PORT` (9464), its own server, never the public port, never published by Compose nor routed by the proxy. Names differ by the unit suffix: Prometheus appends it to OTLP metrics (`http_server_request_duration_seconds`), the JavaScript exporter does not (`http_server_request_duration`). Counters end in `_total` in both.
- **Exemplars**: not supported by the OpenTelemetry JavaScript SDK; trace-derived metrics belong to `observability-stack` (Tempo).
- **Local**: `docker compose --profile observability up` adds `grafana/otel-lgtm` (Grafana, Tempo, Loki and Prometheus in one container, development only) with a provisioned dashboard: request rate, status codes, latency and server errors by route, failed logins by reason, refresh-token reuse, tasks created, connection pool, query latency, event loop. `pnpm smoke:observability` checks it end to end. Walkthrough: [observability.md](observability.md).

---

## 7. Configuration

All env vars validated at startup (zod); invalid config → exit 1 with precise message, no secret values printed. Empty values count as unset; every invalid variable is reported at once.

| Variable                                         | Default                       | Notes                                                                                                              |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                       | `development`                 | `production` enforces strict checks (e.g. rejects empty or default database passwords)                             |
| `HOST`                                           | `127.0.0.1`                   | interface to bind; the container image sets `0.0.0.0`                                                              |
| `PORT`                                           | 3000                          |                                                                                                                    |
| `METRICS_HOST` / `METRICS_PORT`                  | `127.0.0.1` / 9464            | internal `/metrics`; the image binds `0.0.0.0`; the port must differ from `PORT`                                   |
| `DATABASE_URL` (or `DATABASE_URL_FILE`)          | —                             | required, `postgres://` or `postgresql://`; setting both is an error                                               |
| `JWT_PRIVATE_KEY_FILE` / `JWT_PUBLIC_KEY_FILE`   | —                             | Ed25519 PEM; required by the API (not by `migrate`); `pnpm keys:generate` for dev                                  |
| `JWT_PREVIOUS_PUBLIC_KEY_FILE`                   | —                             | Previous public key, accepted during a key rotation                                                                |
| `JWT_ISSUER` / `JWT_AUDIENCE`                    | `secure-api-pipeline`         |                                                                                                                    |
| `CORS_ORIGINS`                                   | —                             | comma-separated origins (`scheme://host[:port]`); https only in production; also allowed to use the refresh cookie |
| `TRUST_PROXY`                                    | off                           | proxies trusted for `X-Forwarded-For`: a hop count (1–10) or IPs/CIDRs; `true` is refused                          |
| `RATE_LIMIT_MULTIPLIER`                          | 1                             | factor (1–1000) on every rate limit; test environments only (the DAST stack uses 100); refused in production       |
| `API_DOCS_ENABLED`                               | `true` (dev) / `false` (prod) |                                                                                                                    |
| `LOG_LEVEL`                                      | `info`                        | `fatal` · `error` · `warn` · `info` · `debug` · `trace` · `silent`                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | —                             | OTLP/HTTP collector for traces, metrics and logs; unset: nothing is pushed                                         |
| `OTEL_TRACES_SAMPLER_ARG`                        | 0.1                           | share of traces kept (0–1); `OTEL_TRACES_SAMPLER` is refused                                                       |
| `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` | `secure-api` / —              | resource attributes; version and `deployment.environment.name` are set by the API                                  |
| `OTEL_METRIC_EXPORT_INTERVAL`                    | 60000                         | OTLP metric push interval (ms); the other standard batch variables (`OTEL_BSP_*`, `OTEL_BLRP_*`) apply too         |
| `OTEL_SDK_DISABLED`                              | `false`                       | disables all telemetry                                                                                             |

Compose reads its own variables from `.env`: `API_OTLP_ENDPOINT` (the API's collector inside the Compose network, `http://otel-lgtm:4318` with the observability profile), `COMPOSE_PROFILES`, and the host ports `API_PORT`, `POSTGRES_PORT`, `GRAFANA_PORT`, `OTLP_HTTP_PORT`.

`.env.example` documents every variable. Rate limits, lockout and token lifetimes are constants changed by review, not configuration (ADR-0004, ADR-0009).

---

## 8. Container & runtime

- Multi-stage `Dockerfile` (ADR-0007): the `node:24-alpine` stages run on the build machine's platform (`--platform=$BUILDPLATFORM`) — a build stage (`pnpm install --frozen-lockfile`, `tsc`) and a production-dependencies stage (`pnpm install --prod --frozen-lockfile --ignore-scripts --os linux --cpu <target> --libc glibc`, so native modules such as `@node-rs/argon2` match the runtime's glibc and CPU) → `gcr.io/distroless/nodejs24-debian13:nonroot` runtime: Node.js and glibc only, no shell or package manager, uid 65532, application files owned by root. The runtime stage only copies files, so `linux/amd64` and `linux/arm64` build without emulation.
- Base images pinned by digest (Dependabot updates them).
- `ENTRYPOINT ["/nodejs/bin/node"]` and `CMD ["--import", "./dist/telemetry/instrument.js", "dist/main.js"]`: the telemetry preload runs first (ADR-0006). `dist/migrate.js` (Compose `migrate`, `command: [dist/migrate.js]`) and the health check run without it. `METRICS_HOST=0.0.0.0` lets a scraper on the Docker network reach `/metrics`; port 9464 is never published.
- `HEALTHCHECK` via `/nodejs/bin/node dist/healthcheck.js` (no shell in distroless).
- Labels and index annotations: OCI (`org.opencontainers.image.source`, `revision`, `version`, `created`), set by `container.yml`.
- Compose (`compose.yaml`): `api`, `migrate` (one-shot, runs before `api`; Phase 1), `postgres`, `nginx` (prod profile, TLS; Phase 5), `otel-lgtm` (observability profile, pinned by digest, Grafana and OTLP/HTTP on `127.0.0.1`; Phase 3). Ports published on `127.0.0.1` only. API container: `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, resource limits (memory, CPU, PIDs).
- Access-token signing keys reach the API as Compose secrets (files under `/run/secrets`), never as environment values or image layers; the files must be readable by uid 65532.

---

## 9. CI/CD pipeline

All workflows: `permissions:` least privilege at workflow and job level, Actions **pinned by full SHA**, `concurrency` groups, `step-security/harden-runner` in audit mode.

| Workflow             | Trigger                                                | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Blocks merge                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `ci.yml`             | PR, push main                                          | lint (ESLint + Prettier) · typecheck · unit (fast, no Docker) · integration (unit, integration and security suites on Testcontainers; coverage ≥ 85 %) · build (TypeScript, image, Compose smoke test: `/health/ready`, then register, log in and `/v1/me`) · observability (Compose with the observability profile, `pnpm smoke:observability`; on pull requests the heavy steps are skipped by `dorny/paths-filter` when no telemetry, Compose, dashboard or dependency file changed, and the job always reports)                              | ✅                              |
| `pr-title.yml`       | PR (opened, edited, synchronize, reopened)             | commitlint on the PR title, which becomes the squash commit read by release-please                                                                                                                                                                                                                                                                                                                                                                                                                                                               | ✅                              |
| `security.yml`       | PR, push main, weekly                                  | codeql (CodeQL `security-extended`) · semgrep (OWASP Top 10 + Node.js rules) · secrets (Gitleaks over the history) · dependencies (OSV-Scanner + `pnpm audit --prod`) · trivy-config (Trivy misconfiguration: Dockerfile, Compose)                                                                                                                                                                                                                                                                                                               | ✅ (high/critical)              |
| `container.yml`      | PR, push main (build and scan only), release published | build-scan (one multi-arch build into an OCI archive · image checks and a real login on amd64 · Trivy on both images, fails on fixable HIGH/CRITICAL · Syft SBOM, SPDX + CycloneDX) · image-arm64 (same checks on a native arm64 runner) · on a release only: publish (the checked archive pushed to GHCR with its digests · **cosign keyless sign** · SLSA provenance and SBOM attestations, `actions/attest`) · release-assets (SBOMs and attestation bundles on the GitHub Release) · verify-image (`cosign verify`, `gh attestation verify`) | ✅ (build-scan, image-arm64)    |
| `dast.yml`           | PR, push main · nightly, release published, manual     | zap (PR, main): Compose up with rate limits raised (`RATE_LIMIT_MULTIPLIER=100`) → seeded user and data → OWASP ZAP **API scan** of a copy of `/openapi.json` with valid example values (`scripts/dast-openapi.ts`), as a logged-in member, with the JSON-API policy `.zap/pr.policy` within 12 minutes → SARIF, report artifact; fails on High alerts **or on any rule that did not complete** · zap-full (nightly, release, manual): the same with every installed rule, within 180 minutes, the token renewed by a new login every 10 minutes | ✅ (zap: High, incomplete scan) |
| `scorecard.yml`      | push main, weekly, branch protection changes           | scorecard: OpenSSF Scorecard → SARIF + published score (badge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                               |
| `release-please.yml` | push main                                              | Release PR opened with a GitHub App token so its required checks run (ADR-0003), tags, GitHub Release; the release event, sent with the App token, starts the image release in `container.yml`                                                                                                                                                                                                                                                                                                                                                   | —                               |
| `deploy.yml`         | Release published / manual                             | Environment `production` (required reviewer) → see §10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                               |

All scanners upload **SARIF** to GitHub code scanning (ZAP through `scripts/zap-report.ts`). One tool per kind of finding: dependency advisories come from OSV-Scanner only, Trivy covers configuration and image packages. Scanners run as images pinned by digest in `.github/scanners/compose.yaml`, which Dependabot keeps current. A finding is dismissed only in the scanner's ignore file, with its reason recorded in `docs/security-pipeline.md` (ADR-0007).

Required status checks on `main` (rulesets match job names): `lint`, `typecheck`, `unit`, `build`, `conventional-title` (Phase 0); `integration` (Phase 1); `observability` (Phase 3); `codeql`, `semgrep`, `secrets`, `dependencies`, `trivy-config`, `build-scan`, `image-arm64`, `zap` (Phase 4). Job names stay unique across workflows. A required job never filters its trigger by path: it runs on every pull request and skips its heavy steps inside the job when nothing relevant changed, so it always reports. A new check becomes required only after three consecutive passing runs.

---

## 10. Deployment

Target: Ubuntu VPS hardened by `server-hardening-kit`, Docker + Nginx (TLS, Let's Encrypt), backed up by `drkit`.

`deploy.yml`:

1. Resolve image **digest** from the release.
2. SSH (dedicated deploy user, key in environment secret, host key pinned in `known_hosts` secret).
3. On server: `cosign verify` the image (certificate identity = this repo's workflow) — **abort if verification fails**.
4. Record current digest (for rollback), update `.env` image reference, `docker compose run --rm migrate`, `docker compose up -d api`.
5. Poll `/health/ready` (timeout 120 s), then run **k6 smoke test** against the public URL (p95 < 300 ms, error rate < 1 %).
6. On failure: redeploy previous digest, verify health, mark job failed, notify.
7. Write deployment summary (`$GITHUB_STEP_SUMMARY`) with version, digest, duration.

Migrations must be **backward compatible** (expand/contract) so rollback of the app never needs a DB rollback — documented in ADR.

`deploy/` contains: `compose.prod.yaml`, Nginx site config (TLS, HSTS, proxy headers, rate limit, `/metrics` not exposed), `dr.yaml` example for `drkit`, and setup notes referencing `server-hardening-kit`.

---

## 11. Testing strategy

| Level       | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | permission matrix, token issuance and verification, signing keys, password hashing and policy, config parsing, problem details, pagination, logging and redaction, plugins (headers, CORS, client IP, rate limit), cleanup scheduling, telemetry (configuration, sampler, span redaction, service spans, metrics), Compose and dashboard invariants                                                                                                                                                                              |
| Integration | every route via `app.inject()` against real PostgreSQL (Testcontainers), migrations applied; services and repositories, whose rules rely on transactions, locks and constraints; the API process started with the telemetry preload, exporting to an in-test OTLP receiver (route-named spans, service and query spans, correlated logs, metrics)                                                                                                                                                                                |
| Security    | authorization matrix over HTTP (every role × action) and cross-tenant access for every resource → 404, with real access tokens; refresh reuse detection; lockout and device cookies; identical failures and argon2 cost for unknown, wrong and locked logins; rate limits; CSRF checks; forged, expired and foreign tokens; secrets never in logs or stored in clear; secrets and personal data (beyond ids) never in exported spans, logs and metrics, `/metrics` or stdout; a hanging collector slows nothing; headers present |
| Telemetry   | `pnpm smoke:observability`: trace HTTP → service → pg in Tempo, its logs in Loki by `trace_id`, metrics in Prometheus, dashboard queries valid (CI `observability`)                                                                                                                                                                                                                                                                                                                                                              |
| Image       | the release image itself (`container.yml`): non-root user, no shell, entrypoint and preload, argon2 binary for glibc and the right CPU, a real register and login on amd64 and arm64                                                                                                                                                                                                                                                                                                                                             |
| DAST        | ZAP API scan in CI: a JSON-API policy on every pull request, every rule nightly and on releases; a scan that does not complete fails                                                                                                                                                                                                                                                                                                                                                                                             |
| Performance | k6 smoke (CI on main, post-deploy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Services are not unit-tested with mocked repositories: a mock would assert the calls instead of the behavior that matters (atomic multi-step changes, row locks, foreign keys). Each test file gets its own database, copied from a migrated template, so files run in parallel.

Coverage gate 85 % lines, branches, functions and statements, measured over the unit, integration and security suites together (CI `integration` job), excluding process entry points and the telemetry preload.

---

## 12. Repository structure

```
secure-api-pipeline/
├── .github/
│   ├── workflows/ (ci, pr-title, security, container, dast, scorecard, release-please, deploy)
│   ├── actions/setup/ (Node.js + pnpm + dependencies, shared by jobs)
│   ├── scanners/compose.yaml (scanner images pinned by digest, run by the workflows)
│   ├── ISSUE_TEMPLATE/ · pull_request_template.md · CODEOWNERS · dependabot.yml
├── deploy/ (compose.prod.yaml, nginx/, dr.yaml, README.md)
├── docs/
│   ├── DESIGN.md · problems.md · threat-model.md · observability.md · runbook.md · security-pipeline.md
│   └── adr/
├── observability/grafana/ (dashboard and its provisioning, for the observability profile)
├── scripts/ (generate-keys, build-blocklist, observability-smoke, seed, image-check, dast-openapi, zap-report, zap-coverage)
├── src/ …
├── tests/ (unit/, integration/, security/, k6/)
├── .husky/ (pre-commit: lint-staged + Gitleaks · commit-msg: commitlint)
├── compose.yaml · Dockerfile · .dockerignore
├── package.json · pnpm-lock.yaml · pnpm-workspace.yaml · tsconfig.json · tsconfig.build.json
├── eslint.config.js · .prettierrc.json · vitest.config.ts · commitlint.config.js · lint-staged.config.js
├── release-please-config.json · .release-please-manifest.json
├── .env.example · .editorconfig · .gitattributes · .gitignore · .nvmrc
├── CHANGELOG.md · CONTRIBUTING.md · SECURITY.md · LICENSE
└── README.md
```

---

## 13. Roadmap

Each phase = one branch → PR → merge → release-please release PR merged (except Phase 0). Done only when all acceptance criteria pass and required checks are green.

### Phase 0 — Foundation (`chore/foundation`) ✅

- Scaffold (§12), TypeScript/ESLint/Prettier/Vitest config, husky + lint-staged + commitlint, `.nvmrc`, corepack/pnpm.
- Config module (zod), `buildApp()`, problem-details error handler, request id, pino with redaction, health endpoints, graceful shutdown.
- `compose.yaml` (api + postgres), basic Dockerfile.
- `ci.yml` (lint, typecheck, unit, build with Compose smoke test), `pr-title.yml`, Dependabot, CODEOWNERS, templates, `SECURITY.md`, `CONTRIBUTING.md`, release-please config.
- ADR-0001 Fastify + zod · ADR-0002 Drizzle + SQL migrations · ADR-0003 pnpm + release-please.

**Done when:** `pnpm dev` and `docker compose up` serve `/health/ready`; CI green; the `ci` jobs (and `conventional-title`) required on `main`.

### Phase 1 — Domain & data (`feat/domain`, → `v0.1.0`) ✅

- Schema + migrations, repositories scoped by workspace, services, routes for workspaces/projects/tasks/members (temporary dev auth stub behind `NODE_ENV=test` only).
- Permission matrix and tenant isolation (service authorization, workspace-scoped repositories, composite foreign keys), with the authorization-matrix and cross-tenant suites.
- Cursor pagination, filters, OpenAPI at `/docs`.
- Integration tests with Testcontainers; `integration` job in `ci.yml` added to the required checks.
- `migrate` Compose service; `/health/ready` also checks that migrations are applied.
- `release-please.yml`, with a GitHub App token for release PRs that triggers the required checks (ADR-0003).
- `docs/threat-model.md` started with the known residual risks · ADR-0005 tenant isolation.

**Done when:** all CRUD routes covered by integration tests; authorization matrix test covers every role × action; cross-tenant requests answer 404 for every resource; OpenAPI valid; coverage ≥ 85 %.

### Phase 2 — Authentication & authorization (`feat/auth`, → `v0.2.0`) ✅

- Register/login/refresh/logout, `/v1/me`, argon2id with a breached-password blocklist, Ed25519 JWT with key rotation, refresh rotation + reuse detection (ADR-0004).
- Lockout with device cookies, rate limits shared through PostgreSQL, `TRUST_PROXY`, security headers and CORS allowlist (ADR-0009).
- Bearer authentication replaces the test stub; audit events in the same transaction, append-only with 365-day retention, and their endpoint (`audit:read`).
- Invitation links replace adding members by email, a breaking change (ADR-0010).
- Security test suite (§11) completed; full `docs/threat-model.md`.

**Done when:** the authorization-matrix and cross-tenant suites run with real tokens; reuse detection revokes the family; lockout and rate limits are covered by tests; audit events are written in the same transaction as the change.

### Phase 3 — Observability (`feat/observability`, → `v0.3.0`) ✅

- OTel SDK preloaded with `node --import`; traces HTTP → service → pg named by route template; metrics (§6) over OTLP and on an internal `/metrics` port; logs correlated by `trace_id` and exported over OTLP.
- Privacy: opaque ids only, no headers, bodies, query values, SQL parameters or error messages; inbound trace context ignored; security suite over every exported signal.
- `observability` Compose profile (`grafana/otel-lgtm`) with a provisioned dashboard, smoke test and the `observability` CI job, added to the required checks.
- ADR-0006 telemetry · `docs/observability.md`.

**Done when:** a request produces a trace (HTTP → service → pg span), latency histogram with route labels, and a log line with matching `trace_id`, visible in local Grafana.

### Phase 4 — DevSecOps pipeline (`feat/security-pipeline`, → `v0.4.0`) ✅

- Hardened distroless image, `security.yml`, `container.yml` (Trivy, SBOM, cosign, provenance, GHCR), `dast.yml` (ZAP), `scorecard.yml`, harden-runner, SHA-pinned actions.
- Required checks updated; `docs/security-pipeline.md` (diagram + what each gate catches + how to verify an image with cosign).
- ADR-0007 supply-chain strategy.
- The distroless runtime uses glibc while the dependency stage is Alpine (musl): install the `@node-rs/argon2` binary for the runtime's libc (pnpm `--os`/`--cpu`/`--libc`), proven by a login inside the final image.

**Done when:** a release image in GHCR verifies with `cosign verify` and `gh attestation verify`; SBOM attached; all scanners report to the Security tab; Scorecard badge published.

### Phase 5 — Deploy & v1.0 (`feat/deploy`, → `v1.0.0`)

- `deploy/`, `deploy.yml` with environment approval, cosign verification on server, migrations, k6 smoke, automatic rollback.
- `docs/runbook.md` (deploy, rollback, rotate JWT keys, incident steps), ecosystem diagram in README, `drkit` `dr.yaml` example.
- ADR-0008 expand/contract migrations.
- Separate PostgreSQL roles: a migration role that owns the schema, and a runtime role with only what the API needs, without `UPDATE` or `DELETE` on `audit_events`; expired events deleted through a dedicated role or a `SECURITY DEFINER` function (threat model RR-5).

**Done when:** a release deploys to the VPS end-to-end; a deliberately broken release is rolled back automatically (documented with screenshots/logs); README "Pipeline" section reflects real runs.

---

## 14. ADR index

| #    | Title                                                           |
| ---- | --------------------------------------------------------------- |
| 0001 | Fastify with zod type provider                                  |
| 0002 | Drizzle ORM with reviewed SQL migrations                        |
| 0003 | pnpm and release-please for versioning                          |
| 0004 | Token strategy: short JWT + rotating opaque refresh tokens      |
| 0005 | Tenant isolation enforced at repository layer                   |
| 0006 | OpenTelemetry for traces, metrics and correlated logs           |
| 0007 | Supply-chain security: SBOM, cosign keyless, SLSA provenance    |
| 0008 | Expand/contract migrations for safe rollbacks                   |
| 0009 | Brute-force protection: rate limits, lockout and device cookies |
| 0010 | Member invitations by single-use link                           |

Format: Context · Decision · Alternatives considered · Consequences.
