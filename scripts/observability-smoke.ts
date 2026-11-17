/**
 * Smoke test of the observability profile (docs/observability.md). Sends
 * traffic to the API, then checks through Grafana's data source proxy that:
 *
 * - Tempo has the trace of a request, from the HTTP span through the service
 *   span down to its database queries;
 * - Loki has the logs of that request, carrying its trace id;
 * - Prometheus has the request, business, database and runtime metrics;
 * - Grafana provisioned the dashboard, and each of its queries is valid.
 *
 *   docker compose --profile observability up --detach --wait
 *   node scripts/observability-smoke.ts
 *
 * The API must keep every trace (OTEL_TRACES_SAMPLER_ARG=1.0, as in
 * .env.example) and push metrics often (e.g. OTEL_METRIC_EXPORT_INTERVAL=5000).
 * SMOKE_API_URL (default http://localhost:3000), SMOKE_GRAFANA_URL (default
 * http://localhost:3001) and SMOKE_TIMEOUT_MS (default 120000) override the
 * defaults. Exits 1 on the first failed check.
 */
import { randomUUID } from 'node:crypto';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3000';
const GRAFANA = process.env.SMOKE_GRAFANA_URL ?? 'http://localhost:3001';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
const SERVICE = 'secure-api';
const TASKS_ROUTE = '/v1/workspaces/:wsId/projects/:projectId/tasks';
const DASHBOARD_UID = 'secure-api';

type Json = Record<string, unknown>;

function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function send(
  path: string,
  init: RequestInit & { token?: string; json?: unknown },
  expected: number,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set('authorization', `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  if (response.status !== expected) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}, expected ${expected}`);
  }
  return response;
}

/** GET through Grafana's proxy to one of the provisioned data sources. */
async function grafana(path: string, query: Record<string, string> = {}): Promise<Json> {
  const url = new URL(path, GRAFANA);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status}`);
  return (await response.json()) as Json;
}

/** Retries `check` until it returns a value: telemetry arrives in batches. */
async function eventually<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await check();
      if (result !== undefined) {
        report(`ok    ${what}`);
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out waiting for ${what}${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Register, log in (and fail once), create a project and a task. */
async function traffic(): Promise<{ requestId: string }> {
  const email = `smoke-${randomUUID()}@example.test`;
  const password = 'smoke passphrase for the observability stack';
  await send(
    '/v1/auth/register',
    { method: 'POST', json: { email, password, name: 'Smoke' } },
    201,
  );
  await send(
    '/v1/auth/login',
    { method: 'POST', json: { email, password: 'not the passphrase at all' } },
    401,
  );
  const login = await send('/v1/auth/login', { method: 'POST', json: { email, password } }, 200);
  const { accessToken: token } = (await login.json()) as { accessToken: string };
  const me = await send('/v1/me', { token }, 200);
  const { memberships } = (await me.json()) as { memberships: { workspaceId: string }[] };
  const workspaceId = memberships[0]?.workspaceId ?? '';
  const project = await send(
    `/v1/workspaces/${workspaceId}/projects`,
    { method: 'POST', token, json: { name: 'Smoke' } },
    201,
  );
  const { id: projectId } = (await project.json()) as { id: string };
  const task = await send(
    `/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`,
    { method: 'POST', token, json: { title: 'Traced from end to end' } },
    201,
  );
  report('ok    traffic sent');
  return { requestId: task.headers.get('x-request-id') ?? '' };
}

interface TempoSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
}

/** The spans of a trace, flattened, from Tempo's OTLP JSON. */
function spansOf(trace: Json): (TempoSpan & { scope: string })[] {
  const body = (trace.trace ?? trace) as {
    resourceSpans?: { scopeSpans?: { scope?: { name?: string }; spans?: TempoSpan[] }[] }[];
  };
  return (body.resourceSpans ?? []).flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map((span) => ({ ...span, scope: scope.scope?.name ?? '' })),
    ),
  );
}

async function checkTrace(requestId: string): Promise<string> {
  const traceId = await eventually('Tempo: the trace of the request', async () => {
    const found = await grafana('/api/datasources/proxy/uid/tempo/api/search', {
      q: `{ resource.service.name = "${SERVICE}" && span.request.id = "${requestId}" }`,
      limit: '1',
    });
    return (found.traces as { traceID: string }[] | undefined)?.[0]?.traceID;
  });
  await eventually('Tempo: HTTP → service → database spans', async () => {
    const spans = spansOf(
      await grafana(`/api/datasources/proxy/uid/tempo/api/v2/traces/${traceId}`),
    );
    const server = spans.find((span) => span.name === `POST ${TASKS_ROUTE}`);
    const service = spans.find((span) => span.name === 'tasks.create');
    const queries = spans.filter((span) => span.parentSpanId === service?.spanId);
    const complete =
      server !== undefined &&
      service !== undefined &&
      queries.length > 0 &&
      queries.every((span) => span.scope === '@opentelemetry/instrumentation-pg');
    return complete ? true : undefined;
  });
  return traceId;
}

async function checkLogs(traceId: string): Promise<void> {
  await eventually('Loki: the logs of the request, with its trace id', async () => {
    const found = await grafana('/api/datasources/proxy/uid/loki/loki/api/v1/query_range', {
      query: `{service_name="${SERVICE}"} | trace_id="${traceId}"`,
      since: '1h',
      limit: '10',
    });
    const streams = (found.data as { result?: { values: [string, string][] }[] }).result ?? [];
    const lines = streams.flatMap((stream) => stream.values.map(([, line]) => line));
    return lines.includes('request completed') ? true : undefined;
  });
}

async function prometheus(query: string): Promise<{ value: [number, string] }[]> {
  const found = await grafana('/api/datasources/proxy/uid/prometheus/api/v1/query', { query });
  if (found.status !== 'success') throw new Error(`query failed: ${query}`);
  return (found.data as { result: { value: [number, string] }[] }).result;
}

async function checkMetrics(): Promise<void> {
  const job = `job="${SERVICE}"`;
  const expectations: [string, string][] = [
    [
      'request duration by route',
      `http_server_request_duration_seconds_count{${job}, http_route="${TASKS_ROUTE}"}`,
    ],
    ['failed logins by reason', `auth_login_failures_total{${job}, reason="wrong_password"}`],
    ['tasks created', `tasks_created_total{${job}}`],
    ['database connection pool', `db_client_connection_max{${job}}`],
    ['query duration', `db_client_operation_duration_seconds_count{${job}}`],
    ['event loop delay', `nodejs_eventloop_delay_p99_seconds{${job}}`],
  ];
  for (const [what, query] of expectations) {
    await eventually(`Prometheus: ${what}`, async () =>
      (await prometheus(query)).length > 0 ? true : undefined,
    );
  }
}

async function checkDashboard(): Promise<void> {
  const { dashboard } = (await eventually('Grafana: the provisioned dashboard', () =>
    grafana(`/api/dashboards/uid/${DASHBOARD_UID}`),
  )) as { dashboard: { panels: { title: string; targets?: { expr: string }[] }[] } };
  const queries = dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({ title: panel.title, expr: target.expr })),
  );
  for (const { title, expr } of queries) {
    const query = expr
      .replaceAll('$job', SERVICE)
      .replaceAll('$__rate_interval', '1m')
      .replaceAll('$__range', '1h');
    await prometheus(query).catch((error: unknown) => {
      throw new Error(`dashboard panel "${title}": ${String(error)}`);
    });
  }
  report(`ok    Grafana: ${queries.length} dashboard queries are valid`);
}

if (import.meta.main) {
  try {
    const { requestId } = await traffic();
    const traceId = await checkTrace(requestId);
    await checkLogs(traceId);
    await checkMetrics();
    await checkDashboard();
    report('observability smoke test passed');
  } catch (error) {
    process.stderr.write(`observability smoke test failed: ${String(error)}\n`);
    process.exit(1);
  }
}
