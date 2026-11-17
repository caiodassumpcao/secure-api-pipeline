# 0006. OpenTelemetry for traces, metrics and correlated logs

- Status: Accepted
- Date: 2026-11-17

## Context

Operating the API needs to answer, per request, where the time went and why it failed, and to watch rates, errors, latency and security events (failed logins, refresh-token reuse) over time. The future `observability-stack` will receive OTLP and scrape Prometheus endpoints; until then a developer must see the same signals locally. Telemetry crosses a trust boundary: whatever a span, log record or metric carries is copied to another system, kept there and read by other people, so it must never carry secrets, and personal data only where needed. Instrumentation that patches modules must load before them, and a slow or missing collector must never slow the API down.

## Decision

- **OpenTelemetry Node SDK, started before the app** by a preload: `node --import ./dist/telemetry/instrument.js dist/main.js` (Dockerfile, `pnpm start`, `pnpm dev`). ESM imports are evaluated before any code of `main.ts` runs, so starting the SDK there would be too late to patch `pg` and `pino`. The preload registers import-in-the-middle hooks for those two modules only and imports nothing that loads them.
- **Explicit instrumentations**, each configured for privacy, instead of the auto-instrumentation bundle: HTTP (incoming only; health probes and API docs untraced), `@fastify/otel` (route template as `http.route`, request id), `pg` (statement text, which is always parameterized, never parameter values; only inside a request), `pino` (trace context in every line), Node runtime metrics. Service methods get their own spans (`tasks.create`), with `user.id` and `workspace.id` as attributes: opaque ids, never an email or a name.
- **Errors without messages**: spans record `error.type` (problem type or error class), and only 5xx responses mark a span as failed. A redacting exporter drops exception messages, stack traces and status messages, strips query strings from paths, masks sensitive query parameters in URLs, and drops attributes whose key names a credential. Headers and bodies are never recorded.
- **Sampling**: parent-based trace-id ratio, **0.1 by default**, safe for production traffic; `OTEL_TRACES_SAMPLER_ARG` changes the ratio (`.env.example` sets 1.0 for development), and `OTEL_TRACES_SAMPLER` is refused. Spans exist even when not exported, so logs always carry trace ids.
- **No inbound trace context**: `traceparent` from clients is ignored, so a client can neither attach its requests to a trace of its choosing nor force sampling. It can be enabled later, trusting only the Phase 5 proxy: Nginx replaces whatever the client sent and the API extracts context from it alone.
- **Export**: with `OTEL_EXPORTER_OTLP_ENDPOINT` set, traces, metrics and logs are pushed over OTLP/HTTP; batch processors with bounded queues and export timeouts drop data rather than block requests, and shutdown waits at most 3 seconds for a final flush. Metrics are also served for scraping on **`/metrics` on an internal port** (`METRICS_HOST`/`METRICS_PORT`, own HTTP server, must differ from `PORT`), never published by Compose nor routed by the proxy.
- **Logs** stay JSON on stdout, with `trace_id` and `span_id`; with an endpoint, pino records are also sent over OTLP, which delivers them to Loki with the trace context as structured fields. A backend must not collect the API's stdout as well, or every line arrives twice.
- **Metric names** follow the semantic conventions (`http.server.request.duration`, `db.client.connection.*`, `db.client.operation.duration`, `nodejs.eventloop.*`, `v8js.*`), plus three business counters: `auth.login.failures{reason}`, `auth.token.reuse_detected`, `tasks.created`. The request count is the histogram's count. Prometheus adds unit suffixes to OTLP metrics (`http_server_request_duration_seconds`); the JavaScript Prometheus exporter does not (`http_server_request_duration`, unit in `# UNIT`). Dashboards in this repository use the OTLP names.
- **Local stack**: Compose profile `observability` with `grafana/otel-lgtm` and a provisioned dashboard; `pnpm smoke:observability` checks traces, logs, metrics and the dashboard end to end, in CI too.

## Alternatives considered

- **`@opentelemetry/auto-instrumentations-node`**: one line of setup, but dozens of instrumentation packages for modules the API does not use, each a dependency to trust and a source of attributes to audit.
- **Starting the SDK at the top of `main.ts`**: modules imported by `main.ts` load before its first statement, so `pg` and `pino` would be unpatched.
- **Trusting inbound `traceparent`**: joins traces with the caller's, but lets any client choose trace ids and the sampling decision. No upstream service needs it yet.
- **Logs collected from stdout by an agent**: the usual setup, but the trace context would have to be parsed back out of each line; OTLP carries it as fields. Doing both duplicates lines.
- **Push-only or pull-only metrics**: pull suits a Prometheus that can reach the API without a collector; push is what otel-lgtm and OTLP backends expect. The cost is two names for the same series.
- **Exemplars** (trace ids on histogram buckets): the JavaScript SDK does not record them and its Prometheus exporter cannot serialize them. Tempo can derive metrics from spans instead, in `observability-stack`.

## Consequences

- The API must be started with `--import`; without it, it still runs, without telemetry.
- Every new attribute, instrumentation or log field must pass the security suite that searches exported spans, logs, metrics, `/metrics` and stdout for the secrets of a full flow.
- Traces hold opaque user and workspace ids, client IP addresses and user agents: personal data, kept by the telemetry backend for a bounded time (threat model).
- At the default ratio, nine requests in ten have no exported trace; their logs still carry a trace id that leads nowhere.
- Pulled and pushed metric names differ by their unit suffix; queries must use the names of the path in use.
- Traces start at the API until the proxy can be trusted with trace context.
