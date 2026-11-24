/**
 * Smoke test of the observability profile (docs/observability.md). Sends
 * traffic to the API, then checks through Grafana's data source proxy that:
 *
 * - Tempo has the trace of a task request, from the HTTP span through the
 *   service span down to its database queries;
 * - Loki has the logs of such a request, carrying the id of that same trace;
 * - Prometheus has the request, business, database and runtime metrics;
 * - Grafana provisioned the dashboard, and each of its queries is valid.
 *
 *   docker compose --profile observability up --detach --wait
 *   node scripts/observability-smoke.ts
 *
 * While it waits for Tempo and Loki it keeps creating a task every few
 * seconds, so a batch exported while the stack was still settling cannot fail
 * the run on its own; the timeouts stay the same. On a Loki timeout it prints
 * the last response and the collector's log counters.
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
const RESEND_EVERY_MS = 5_000;
// Request ids searched for: the latest ones, which span more than a timeout.
const SEARCHED_REQUESTS = 30;
const SERVICE = 'secure-api';
const TASKS_ROUTE = '/v1/workspaces/:wsId/projects/:projectId/tasks';
const DASHBOARD_UID = 'secure-api';

type Json = Record<string, unknown>;

const startedAt = Date.now();

function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

function elapsed(): string {
  return `${((Date.now() - startedAt) / 1_000).toFixed(1)} s`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
        report(`ok    ${what} (${elapsed()})`);
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out waiting for ${what}${reason}`);
    }
    await sleep(2_000);
  }
}

interface Session {
  token: string;
  tasksPath: string;
  /** x-request-id of every task created, oldest first. */
  requestIds: string[];
}

/** Register, log in (and fail once) and create a project. */
async function setUp(): Promise<Session> {
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
  return {
    token,
    tasksPath: `/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`,
    requestIds: [],
  };
}

/** Creates a task: the request whose trace and logs are looked for. */
async function createTask(session: Session): Promise<void> {
  const task = await send(
    session.tasksPath,
    { method: 'POST', token: session.token, json: { title: 'Traced from end to end' } },
    201,
  );
  const requestId = task.headers.get('x-request-id');
  if (requestId === null) throw new Error(`POST ${TASKS_ROUTE}: no x-request-id header`);
  session.requestIds.push(requestId);
}

/**
 * Creates a task every few seconds until stopped. A failed request stops the
 * loop; `stop` rethrows its error.
 */
function keepCreatingTasks(session: Session): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const { signal } = controller;
  const loop = (async () => {
    for (;;) {
      await sleep(RESEND_EVERY_MS);
      if (signal.aborted) return;
      await createTask(session);
    }
  })();
  // Handled in `stop`; without this an early failure would be unhandled.
  loop.catch(() => undefined);
  return {
    stop: async () => {
      controller.abort();
      await loop;
    },
  };
}

/** The latest request ids as a TraceQL and LogQL alternation (UUIDs: no escaping). */
function requestPattern(session: Session): string {
  return session.requestIds.slice(-SEARCHED_REQUESTS).join('|');
}

interface TempoSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  attributes?: { key: string; value: { stringValue?: string } }[];
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

/** Trace ids of the task requests sent so far that Tempo can find. */
async function findTraces(session: Session): Promise<string[]> {
  const found = await grafana('/api/datasources/proxy/uid/tempo/api/search', {
    q: `{ resource.service.name = "${SERVICE}" && span.request.id =~ "${requestPattern(session)}" }`,
    limit: '20',
  });
  return ((found.traces as { traceID: string }[] | undefined) ?? []).map((trace) => trace.traceID);
}

/**
 * Whether the trace holds the whole path of a task request (HTTP server span,
 * service span, its queries) and, when given, belongs to that request id.
 */
async function isCompleteTaskTrace(traceId: string, requestId?: string): Promise<boolean> {
  const spans = spansOf(await grafana(`/api/datasources/proxy/uid/tempo/api/v2/traces/${traceId}`));
  const server = spans.find((span) => span.name === `POST ${TASKS_ROUTE}`);
  const service = spans.find((span) => span.name === 'tasks.create');
  const queries = spans.filter((span) => span.parentSpanId === service?.spanId);
  const ofRequest =
    requestId === undefined ||
    spans.some((span) =>
      span.attributes?.some(
        ({ key, value }) => key === 'request.id' && value.stringValue === requestId,
      ),
    );
  return (
    server !== undefined &&
    service !== undefined &&
    queries.length > 0 &&
    queries.every((span) => span.scope === '@opentelemetry/instrumentation-pg') &&
    ofRequest
  );
}

async function checkTraces(session: Session): Promise<void> {
  await eventually('Tempo: the trace of a task request', async () =>
    (await findTraces(session)).length > 0 ? true : undefined,
  );
  await eventually('Tempo: HTTP → service → database spans', async () => {
    for (const traceId of await findTraces(session)) {
      if (await isCompleteTaskTrace(traceId)) return true;
    }
    return undefined;
  });
}

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

/**
 * A `request completed` line of one of the task requests, whose trace id is
 * the complete trace of that same request in Tempo.
 */
async function checkLogs(session: Session): Promise<void> {
  let last: Json | undefined;
  try {
    await eventually('Loki: the logs of a task request, with its trace id', async () => {
      last = await grafana('/api/datasources/proxy/uid/loki/loki/api/v1/query_range', {
        query: `{service_name="${SERVICE}"} | request_id=~"${requestPattern(session)}" | trace_id!=""`,
        since: '1h',
        limit: '100',
      });
      const streams = (last.data as { result?: LokiStream[] }).result ?? [];
      for (const { stream, values } of streams) {
        const { trace_id: traceId, request_id: requestId } = stream;
        if (traceId === undefined || requestId === undefined) continue;
        if (!values.some(([, line]) => line === 'request completed')) continue;
        if (await isCompleteTaskTrace(traceId, requestId)) return true;
      }
      return undefined;
    });
  } catch (error) {
    const response =
      last === undefined ? 'none, every query failed' : JSON.stringify(last).slice(0, 4_000);
    process.stderr.write(`last Loki response: ${response}\n`);
    process.stderr.write(`${await pipelineCounters()}\n`);
    throw error;
  }
}

/**
 * Where log records stopped: the collector's own counters (scraped by the
 * Prometheus of otel-lgtm) and the number of lines Loki holds for the API.
 */
async function pipelineCounters(): Promise<string> {
  const lines = [
    'otelcol_receiver_accepted_log_records_total',
    'otelcol_receiver_refused_log_records_total',
    'otelcol_exporter_sent_log_records_total',
    'otelcol_exporter_send_failed_log_records_total',
    'otelcol_exporter_enqueue_failed_log_records_total',
  ].map(async (metric) => {
    const result = await prometheus(`sum(${metric})`).catch(() => []);
    return `${metric} ${result[0]?.value[1] ?? 'absent'}`;
  });
  const stored = await grafana('/api/datasources/proxy/uid/loki/loki/api/v1/query', {
    query: `sum(count_over_time({service_name="${SERVICE}"}[1h]))`,
  }).catch((error: unknown) => ({ error: String(error) }));
  return [...(await Promise.all(lines)), `loki lines (1h): ${JSON.stringify(stored)}`].join('\n');
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
    const session = await setUp();
    await createTask(session);
    report(`ok    traffic sent (${elapsed()})`);
    const traffic = keepCreatingTasks(session);
    try {
      await checkTraces(session);
      await checkLogs(session);
    } finally {
      await traffic.stop();
    }
    report(`ok    ${session.requestIds.length} task requests sent`);
    await checkMetrics();
    await checkDashboard();
    report('observability smoke test passed');
  } catch (error) {
    process.stderr.write(`observability smoke test failed: ${String(error)}\n`);
    process.exit(1);
  }
}
