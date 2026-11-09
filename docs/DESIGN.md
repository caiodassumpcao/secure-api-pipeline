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

| Repository | Role |
|---|---|
| `server-hardening-kit` | Hardens the VPS this API is deployed to |
| `drkit` | Backs up and recovers the API (database, secrets, compose) |
| `observability-stack` *(future)* | Consumes the API's OTLP telemetry and `/metrics` |

---

## 2. Domain

Multi-tenant **project & task tracker** — small enough to stay focused, rich enough to exercise real authorization.

| Entity | Fields (main) | Notes |
|---|---|---|
| `users` | id (uuid v7), email (unique, citext), password_hash, name, created_at, locked_until | |
| `workspaces` | id, name, slug, created_at | Tenant boundary |
| `memberships` | workspace_id, user_id, role, created_at | Role: `owner` · `admin` · `member` · `viewer` |
| `projects` | id, workspace_id, name, archived_at | |
| `tasks` | id, workspace_id, project_id, title, description, status, priority, assignee_id, due_date, created_by, timestamps | Status: `todo` · `in_progress` · `done` |
| `refresh_tokens` | id, user_id, family_id, token_hash, expires_at, revoked_at, replaced_by | Rotation + reuse detection |
| `audit_events` | id, workspace_id?, actor_id?, action, target, ip, user_agent, metadata (jsonb), created_at | Append-only |

`workspace_id` is denormalized on `tasks` to make tenant filters mandatory and cheap.

### 2.1 Permission matrix

| Action | owner | admin | member | viewer |
|---|:-:|:-:|:-:|:-:|
| Read projects/tasks | ✅ | ✅ | ✅ | ✅ |
| Create/update tasks | ✅ | ✅ | ✅ | ❌ |
| Delete tasks | ✅ | ✅ | own only | ❌ |
| Create/archive projects | ✅ | ✅ | ❌ | ❌ |
| Manage members | ✅ | ✅ (not owners) | ❌ | ❌ |
| Delete workspace / transfer ownership | ✅ | ❌ | ❌ | ❌ |
| Read audit log | ✅ | ✅ | ❌ | ❌ |

The matrix is encoded once (`src/modules/auth/permissions.ts`) and covered by a **table-driven authorization test** that exercises every cell over HTTP.

---

## 3. API

Base path `/v1`. JSON only. Errors follow **RFC 9457** (`application/problem+json`) with `type`, `title`, `status`, `detail`, `instance`, `traceId`. Validation errors include `errors[]` with field paths. Never leak stack traces or SQL.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/auth/register` | — | Create account (+ personal workspace) |
| POST | `/v1/auth/login` | — | Returns access token + sets refresh cookie |
| POST | `/v1/auth/refresh` | cookie | Rotates refresh token |
| POST | `/v1/auth/logout` | ✅ | Revokes refresh token family |
| GET | `/v1/me` | ✅ | Current user + memberships |
| GET/POST | `/v1/workspaces` | ✅ | List / create |
| GET/PATCH/DELETE | `/v1/workspaces/:wsId` | ✅ | |
| GET/POST/PATCH/DELETE | `/v1/workspaces/:wsId/members[/:userId]` | ✅ | |
| GET/POST | `/v1/workspaces/:wsId/projects` | ✅ | |
| PATCH/DELETE | `/v1/workspaces/:wsId/projects/:projectId` | ✅ | Archive |
| GET/POST | `/v1/workspaces/:wsId/projects/:projectId/tasks` | ✅ | Filters: status, assignee, priority; cursor pagination |
| GET/PATCH/DELETE | `/v1/workspaces/:wsId/tasks/:taskId` | ✅ | |
| GET | `/v1/workspaces/:wsId/audit-events` | ✅ | Cursor pagination |
| GET | `/health/live`, `/health/ready` | — | Liveness / readiness (DB ping) |
| GET | `/docs`, `/openapi.json` | — | Disabled in production unless `API_DOCS_ENABLED=true` |

`/metrics` is served on a **separate internal port** (`METRICS_PORT`, default 9464), never through the public proxy.

Pagination: `?limit=` (1–100, default 20) + opaque `?cursor=`; response `{ data: [], nextCursor }`.

---

## 4. Architecture

```
src/
├── main.ts                 # bootstrap: telemetry → config → app → listen, graceful shutdown
├── app.ts                  # buildApp(): Fastify instance, plugins, routes (testable)
├── config/                 # env schema (zod), typed config
├── telemetry/              # OpenTelemetry SDK init (must load first), metrics
├── plugins/                # security headers, cors, rate limit, auth, error handler, request context
├── db/                     # drizzle client, schema, migrations, transaction helper
├── modules/
│   ├── auth/               # routes, service, tokens, password, permissions
│   ├── workspaces/
│   ├── members/
│   ├── projects/
│   ├── tasks/
│   └── audit/
├── lib/                    # problem details, pagination, ids, clock
└── types/
```

Each module: `*.routes.ts` (HTTP + zod schemas) → `*.service.ts` (business rules, authorization) → `*.repository.ts` (SQL, **always scoped by workspace_id**). Services receive dependencies explicitly (no global singletons) to keep unit tests pure.

### 4.1 Technology decisions

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 LTS |
| Language | TypeScript 5 (`strict`, `noUncheckedIndexedAccess`, ESM) |
| Package manager | pnpm (via corepack), lockfile committed, `--frozen-lockfile` in CI |
| HTTP | Fastify 5 + `fastify-type-provider-zod` |
| Validation | zod (request, response and env) |
| Database | PostgreSQL 17 |
| Data access | Drizzle ORM + drizzle-kit SQL migrations (reviewed, committed) |
| Passwords | argon2id (`@node-rs/argon2`) |
| Tokens | `jose` — EdDSA (Ed25519) access JWT, 15 min; opaque refresh token (256-bit), stored hashed (SHA-256), 7 days, `HttpOnly; Secure; SameSite=Strict` cookie, path `/v1/auth` |
| Security plugins | `@fastify/helmet`, `@fastify/cors` (allowlist), `@fastify/rate-limit`, `@fastify/cookie` |
| Logging | pino (JSON), redaction of auth headers, cookies, passwords, tokens |
| Telemetry | OpenTelemetry Node SDK, auto-instrumentation (http, fastify, pg), OTLP/HTTP exporter, Prometheus exporter |
| API docs | `@fastify/swagger` generated from zod schemas |
| Tests | Vitest, `app.inject()`, Testcontainers (PostgreSQL) |
| Lint/format | ESLint (flat config, typescript-eslint strict, `eslint-plugin-security`), Prettier |
| Commits | commitlint (Conventional Commits), husky + lint-staged |
| Releases | release-please (versions, CHANGELOG, GitHub Releases) |

---

## 5. Security design

### 5.1 Controls

| Threat | Control |
|---|---|
| Credential stuffing / brute force | Rate limit per IP and per email on `/auth/*`; progressive lockout (`locked_until`) after N failures; uniform error + constant-time compare to avoid user enumeration |
| Weak passwords | Min 12 chars, max 128, zxcvbn-style score or common-password list check |
| Token theft | Short-lived access JWT; refresh rotation with **reuse detection** (reuse of a rotated token revokes the whole family + audit event); logout revokes family |
| Broken object-level authorization (IDOR) | Every repository query requires `workspaceId`; membership + role checked in service layer; cross-tenant tests for every resource |
| Mass assignment | Explicit zod input schemas (`.strict()`), response schemas strip unknown fields |
| Injection | Parameterized queries only (Drizzle); no raw SQL concatenation (ESLint rule + Semgrep) |
| XSS / clickjacking (docs page) | Helmet CSP, `X-Content-Type-Options`, `frame-ancestors 'none'` |
| CSRF on refresh cookie | `SameSite=Strict`, cookie path restricted, origin check on `/auth/refresh` |
| DoS | Body limit (100 KB), connection/request timeouts, pagination caps, rate limit |
| Sensitive data in logs | pino redaction + test asserting secrets never appear in logs |
| Secrets management | Config from env / Docker secrets files (`*_FILE`); app refuses to start with default or missing secrets in production |
| Supply chain | Lockfile, `pnpm audit`, OSV-Scanner, Dependabot, pinned Actions by SHA, SBOM, signed images, provenance |
| Container escape / privilege | Distroless non-root image, read-only root FS, `no-new-privileges`, dropped capabilities |

### 5.2 Threat model

`docs/threat-model.md`: STRIDE per component (client → Nginx → API → PostgreSQL; CI/CD → GHCR → VPS), data-flow diagram (Mermaid), trust boundaries, assets, mitigations mapped to the table above, residual risks.

### 5.3 Audit events

`auth.login.succeeded|failed`, `auth.locked`, `auth.refresh.reuse_detected`, `auth.logout`, `member.added|removed|role_changed`, `project.archived`, `workspace.deleted`. Written in the same transaction as the change.

---

## 6. Observability

| Signal | Implementation |
|---|---|
| Traces | OTel auto-instrumentation (HTTP, Fastify, pg) + manual spans in services; W3C trace context propagated |
| Metrics | `http_server_request_duration_seconds` (histogram, route template label — never raw URL), `http_server_requests_total`, DB pool metrics, business counters: `auth_login_failures_total`, `auth_token_reuse_detected_total`, `tasks_created_total` |
| Logs | pino JSON with `trace_id`, `span_id`, `request_id`, `user_id` (no PII beyond id) |
| Exemplars | trace ids attached to latency histogram where supported |
| Health | `/health/live` (process), `/health/ready` (DB + migrations applied) |

Config: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME=secure-api`, `OTEL_RESOURCE_ATTRIBUTES` (env, version). Telemetry is optional: if no endpoint is set, traces are not exported but metrics still served.

Local: `docker compose --profile observability up` adds `grafana/otel-lgtm` (Grafana + Prometheus + Tempo + Loki in one container) for development.

---

## 7. Configuration

All env vars validated at startup (zod); invalid config → exit 1 with precise message, no secret values printed.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enforces strict checks |
| `PORT` / `METRICS_PORT` | 3000 / 9464 | |
| `DATABASE_URL` (or `DATABASE_URL_FILE`) | — | required |
| `JWT_PRIVATE_KEY_FILE` / `JWT_PUBLIC_KEY_FILE` | — | Ed25519 PEM; `pnpm keys:generate` for dev |
| `JWT_ISSUER` / `JWT_AUDIENCE` | — | |
| `CORS_ORIGINS` | — | comma-separated allowlist |
| `RATE_LIMIT_*` | sane defaults | |
| `API_DOCS_ENABLED` | `true` (dev) / `false` (prod) | |
| `LOG_LEVEL` | `info` | |
| `OTEL_*` | — | standard OTel vars |

`.env.example` documents every variable.

---

## 8. Container & runtime

- Multi-stage `Dockerfile`: `node:24-alpine` build stage (pnpm install `--frozen-lockfile`, build, `pnpm deploy --prod`) → `gcr.io/distroless/nodejs24-debian12:nonroot` runtime.
- Base images pinned by digest (Dependabot updates them).
- `HEALTHCHECK` via `node dist/healthcheck.js` (no shell in distroless).
- Labels: OCI (`org.opencontainers.image.source`, `revision`, `version`).
- Compose (`compose.yaml`): `api`, `migrate` (one-shot, runs before `api`), `postgres`, `nginx` (prod profile, TLS), `otel-lgtm` (observability profile). API container: `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, resource limits.

---

## 9. CI/CD pipeline

All workflows: `permissions:` least privilege at workflow and job level, Actions **pinned by full SHA**, `concurrency` groups, `step-security/harden-runner` in audit mode.

| Workflow | Trigger | Jobs | Blocks merge |
|---|---|---|---|
| `ci.yml` | PR, push main | lint · typecheck · unit · integration (Testcontainers) · coverage ≥ 85 % · build | ✅ |
| `security.yml` | PR, push main, weekly | Semgrep (OWASP + Node rules) · CodeQL · Gitleaks · OSV-Scanner · `pnpm audit --prod` · Trivy fs + config (Dockerfile, compose) | ✅ (HIGH/CRITICAL) |
| `container.yml` | PR (build + scan only), push main, release | Build multi-arch (amd64/arm64) · Trivy image (fail on fixable HIGH/CRITICAL) · Syft SBOM (SPDX + CycloneDX) · push GHCR · **cosign keyless sign** (OIDC) · SBOM attestation · `actions/attest-build-provenance` (SLSA) | ✅ (scan) |
| `dast.yml` | PR, push main | Compose up → seed → OWASP ZAP **API scan** using `/openapi.json` with authenticated context → report artifact | ✅ (High) |
| `scorecard.yml` | push main, weekly | OpenSSF Scorecard → SARIF + badge | — |
| `release-please.yml` | push main | Release PR, tags, GitHub Release, triggers container release | — |
| `deploy.yml` | Release published / manual | Environment `production` (required reviewer) → see §10 | — |

All scanners upload **SARIF** to GitHub code scanning. Security tab must stay clean (or findings explicitly dismissed with justification).

Required status checks on `main`: `ci / *`, `security / *`, `container / build-scan`, `dast / zap`.

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

| Level | Scope |
|---|---|
| Unit | services, permission matrix, token logic, password policy, config parsing, problem details |
| Integration | every route via `app.inject()` against real PostgreSQL (Testcontainers), migrations applied |
| Security | authorization matrix over HTTP (every role × action), cross-tenant access for every resource → 404, refresh reuse detection, lockout, log redaction, headers present |
| DAST | ZAP API scan in CI |
| Performance | k6 smoke (CI on main, post-deploy) |

Coverage gate 85 % lines/branches (excluding bootstrap and telemetry init).

---

## 12. Repository structure

```
secure-api-pipeline/
├── .github/
│   ├── workflows/ (ci, security, container, dast, scorecard, release-please, deploy)
│   ├── ISSUE_TEMPLATE/ · pull_request_template.md · CODEOWNERS · dependabot.yml
├── deploy/ (compose.prod.yaml, nginx/, dr.yaml, README.md)
├── docs/
│   ├── DESIGN.md · threat-model.md · runbook.md · security-pipeline.md
│   └── adr/
├── scripts/ (generate-keys, seed)
├── src/ …
├── tests/ (unit/, integration/, security/, k6/)
├── compose.yaml · Dockerfile · .dockerignore
├── package.json · pnpm-lock.yaml · tsconfig.json · eslint.config.js · vitest.config.ts
├── .env.example · .editorconfig · .gitattributes · .gitignore · .nvmrc
├── CHANGELOG.md · CONTRIBUTING.md · SECURITY.md · LICENSE
└── README.md
```

---

## 13. Roadmap

Each phase = one branch → PR → merge → release-please release PR merged (except Phase 0). Done only when all acceptance criteria pass and required checks are green.

### Phase 0 — Foundation (`chore/foundation`)
- Scaffold (§12), TypeScript/ESLint/Prettier/Vitest config, husky + lint-staged + commitlint, `.nvmrc`, corepack/pnpm.
- Config module (zod), `buildApp()`, problem-details error handler, request id, pino with redaction, health endpoints, graceful shutdown.
- `compose.yaml` (api + postgres), basic Dockerfile.
- `ci.yml` (lint, typecheck, unit, build), Dependabot, CODEOWNERS, templates, `SECURITY.md`, `CONTRIBUTING.md`, release-please config.
- ADR-0001 Fastify + zod · ADR-0002 Drizzle + SQL migrations · ADR-0003 pnpm + release-please.

**Done when:** `pnpm dev` and `docker compose up` serve `/health/ready`; CI green; required check `ci` enabled on `main`.

### Phase 1 — Domain & data (`feat/domain`, → `v0.1.0`)
- Schema + migrations, repositories scoped by workspace, services, routes for workspaces/projects/tasks/members (temporary dev auth stub behind `NODE_ENV=test` only).
- Cursor pagination, filters, OpenAPI at `/docs`.
- Integration tests with Testcontainers.

**Done when:** all CRUD routes covered by integration tests; OpenAPI valid; coverage ≥ 85 %.

### Phase 2 — Authentication & authorization (`feat/auth`, → `v0.2.0`)
- Register/login/refresh/logout, argon2id, EdDSA JWT, refresh rotation + reuse detection, lockout, rate limits.
- Permission matrix, tenant isolation, audit events + endpoint.
- Security test suite (§11), `docs/threat-model.md`.
- ADR-0004 token strategy · ADR-0005 tenant isolation.

**Done when:** authorization matrix test covers every role × action; cross-tenant tests return 404 for every resource; reuse detection revokes family.

### Phase 3 — Observability (`feat/observability`, → `v0.3.0`)
- OTel SDK, traces, metrics (§6) on internal port, log correlation, readiness checks, `observability` compose profile.
- ADR-0006 telemetry.

**Done when:** a request produces a trace (HTTP → service → pg span), latency histogram with route labels, and a log line with matching `trace_id`, visible in local Grafana.

### Phase 4 — DevSecOps pipeline (`feat/security-pipeline`, → `v0.4.0`)
- Hardened distroless image, `security.yml`, `container.yml` (Trivy, SBOM, cosign, provenance, GHCR), `dast.yml` (ZAP), `scorecard.yml`, harden-runner, SHA-pinned actions.
- Required checks updated; `docs/security-pipeline.md` (diagram + what each gate catches + how to verify an image with cosign).
- ADR-0007 supply-chain strategy.

**Done when:** a release image in GHCR verifies with `cosign verify` and `gh attestation verify`; SBOM attached; all scanners report to the Security tab; Scorecard badge published.

### Phase 5 — Deploy & v1.0 (`feat/deploy`, → `v1.0.0`)
- `deploy/`, `deploy.yml` with environment approval, cosign verification on server, migrations, k6 smoke, automatic rollback.
- `docs/runbook.md` (deploy, rollback, rotate JWT keys, incident steps), ecosystem diagram in README, `drkit` `dr.yaml` example.
- ADR-0008 expand/contract migrations.

**Done when:** a release deploys to the VPS end-to-end; a deliberately broken release is rolled back automatically (documented with screenshots/logs); README "Pipeline" section reflects real runs.

---

## 14. ADR index

| # | Title |
|---|---|
| 0001 | Fastify with zod type provider |
| 0002 | Drizzle ORM with reviewed SQL migrations |
| 0003 | pnpm and release-please for versioning |
| 0004 | Token strategy: short JWT + rotating opaque refresh tokens |
| 0005 | Tenant isolation enforced at repository layer |
| 0006 | OpenTelemetry for traces and metrics |
| 0007 | Supply-chain security: SBOM, cosign keyless, SLSA provenance |
| 0008 | Expand/contract migrations for safe rollbacks |

Format: Context · Decision · Alternatives considered · Consequences.
