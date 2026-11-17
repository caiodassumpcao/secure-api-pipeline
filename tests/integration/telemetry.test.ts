import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';
import { OtlpReceiver, type ReceivedSpan } from './helpers/otlp-receiver.ts';
import { runApiProcessToExit, startApiProcess, type ApiProcess } from './helpers/process.ts';

/**
 * The API as production runs it: `node --import` the telemetry preload, then
 * the app, against a real database.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('telemetry preload', () => {
  let api: ApiProcess | undefined;

  afterAll(async () => {
    await api?.stop();
  });

  it('starts before the app, which then serves requests', async () => {
    api = await startApiProcess({ DATABASE_URL: database.url });

    const response = await fetch(`${api.baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(api.output.filter((line) => line.includes('"level":"error"'))).toEqual([]);
  });

  it('flushes telemetry and exits 0 on SIGTERM', async () => {
    const running = await startApiProcess({ DATABASE_URL: database.url });

    expect(await running.stop()).toBe(0);
  });

  it('refuses to start with an invalid telemetry configuration, without echoing it', async () => {
    const { code, output } = await runApiProcessToExit({
      DATABASE_URL: database.url,
      OTEL_TRACES_SAMPLER_ARG: 'everything-please',
    });

    expect(code).toBe(1);
    expect(output).toContain('invalid telemetry configuration');
    expect(output).toContain('OTEL_TRACES_SAMPLER_ARG: must be a number between 0 and 1');
    expect(output).not.toContain('everything-please');
  });
});

/** Env for a process that exports everything, quickly, to `receiver`. */
export function exportingTo(receiver: OtlpReceiver): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    OTEL_TRACES_SAMPLER_ARG: '1',
    OTEL_BSP_SCHEDULE_DELAY: '100',
    OTEL_BLRP_SCHEDULE_DELAY: '100',
    OTEL_METRIC_EXPORT_INTERVAL: '500',
  };
}

const PASSWORD = 'telemetry passphrase for tests';

/** Registers and logs in over HTTP; returns the access token and personal workspace. */
export async function signIn(baseUrl: string, email: string) {
  const json = { 'content-type': 'application/json' };
  const registered = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email, password: PASSWORD, name: 'Telemetry' }),
  });
  if (registered.status !== 201) throw new Error(`register: ${registered.status}`);
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const me = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const { memberships } = (await me.json()) as { memberships: { workspaceId: string }[] };
  return { accessToken, workspaceId: memberships[0]?.workspaceId ?? '' };
}

describe('traces', () => {
  let receiver: OtlpReceiver;
  let api: ApiProcess;
  let session: { accessToken: string; workspaceId: string };

  beforeAll(async () => {
    receiver = await OtlpReceiver.start();
    api = await startApiProcess({ DATABASE_URL: database.url, ...exportingTo(receiver) });
    session = await signIn(api.baseUrl, `traced-${Date.now()}@example.test`);
    const auth = { authorization: `Bearer ${session.accessToken}` };
    await fetch(`${api.baseUrl}/v1/workspaces/${session.workspaceId}`, { headers: auth });
    await fetch(`${api.baseUrl}/v1/workspaces?limit=5&access_token=leaked-secret`, {
      headers: auth,
    });
    await fetch(`${api.baseUrl}/health/live`);
    await fetch(`${api.baseUrl}/nowhere/at/all`);
  });

  afterAll(async () => {
    await api.stop();
    await receiver.stop();
  });

  const serverSpan = (route: string) =>
    receiver.spans().find((span) => span.kind === 2 && span.attributes['http.route'] === route);

  it('name requests after their route template, never the raw URL', async () => {
    const span = await receiver.waitFor(() => serverSpan('/v1/workspaces/:wsId'));

    expect(span.name).toBe('GET /v1/workspaces/:wsId');
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
    });
  });

  it('read HTTP request → Fastify request → service operation → queries', async () => {
    const server = await receiver.waitFor(() => serverSpan('/v1/workspaces/:wsId'));
    const inTrace = () => receiver.spans().filter((span) => span.traceId === server.traceId);
    const operation = await receiver.waitFor(() =>
      inTrace().find((span) => span.name === 'workspaces.get'),
    );

    const request = inTrace().find((span) => span.spanId === operation.parentSpanId);
    expect(request?.scope).toBe('@fastify/otel');
    expect(request?.parentSpanId).toBe(server.spanId);
    const queries = inTrace().filter((span) => span.parentSpanId === operation.spanId);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((span) => span.attributes['db.system.name'] === 'postgresql')).toBe(true);
  });

  it('carry the request id and the opaque user and workspace ids, nothing personal', async () => {
    const server = await receiver.waitFor(() => serverSpan('/v1/workspaces/:wsId'));
    const trace = receiver.spans().filter((span) => span.traceId === server.traceId);
    const attributes = Object.assign({}, ...trace.map((span) => span.attributes)) as Record<
      string,
      unknown
    >;

    expect(attributes).toMatchObject({
      'request.id': expect.any(String),
      'workspace.id': session.workspaceId,
      'user.id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(trace)).not.toContain('@example.test');
  });

  it('mask sensitive query parameters', async () => {
    const span = await receiver.waitFor(() =>
      receiver
        .spans()
        .find((candidate) => String(candidate.attributes['url.query']).includes('access_token')),
    );

    expect(span.attributes['url.query']).toBe('limit=5&access_token=[REDACTED]');
    expect(receiver.bodies.join('\n')).not.toContain('leaked-secret');
    // The Fastify span records the path alone, and no error message.
    const request = receiver
      .spans()
      .find((candidate) => candidate.parentSpanId === span.spanId && candidate.name === 'request');
    expect(request?.attributes['url.path']).toBe('/v1/workspaces');
    expect(request?.status).toEqual({ code: 2 });
  });

  it('skip the health probes and group unknown routes', async () => {
    const unknown = await receiver.waitFor(() =>
      receiver
        .spans()
        .find((span) => span.kind === 2 && span.attributes['url.path'] === '/nowhere/at/all'),
    );

    expect(unknown.attributes['http.route']).toBeUndefined();
    expect(unknown.name).toBe('GET');
    const paths = receiver.spans().map((span: ReceivedSpan) => String(span.attributes['url.path']));
    expect(paths.filter((path) => path.startsWith('/health/'))).toEqual([]);
  });
});

describe('database spans', () => {
  let receiver: OtlpReceiver;
  let api: ApiProcess;
  const email = `queried-${Date.now()}@example.test`;

  beforeAll(async () => {
    receiver = await OtlpReceiver.start();
    api = await startApiProcess({ DATABASE_URL: database.url, ...exportingTo(receiver) });
    await signIn(api.baseUrl, email);
  });

  afterAll(async () => {
    await api.stop();
    await receiver.stop();
  });

  it('nest parameterized queries under the request that ran them, without values', async () => {
    const login = await receiver.waitFor(() =>
      receiver
        .spans()
        .find((span) => span.kind === 2 && span.attributes['http.route'] === '/v1/auth/login'),
    );
    const queries = await receiver.waitFor(() => {
      const found = receiver
        .spans()
        .filter((span) => span.traceId === login.traceId && span.scope.includes('pg'));
      return found.length > 0 ? found : undefined;
    });

    expect(queries[0]?.attributes).toMatchObject({
      'db.system.name': 'postgresql',
      'db.query.text': expect.stringContaining('$1'),
    });
    const recorded = JSON.stringify(queries);
    expect(recorded).not.toContain(email);
    expect(recorded).not.toContain('argon2id');
    expect(recorded).not.toContain(PASSWORD);
  });
});

describe('logs', () => {
  let receiver: OtlpReceiver;
  let api: ApiProcess;
  const requestId = `log-correlation-${Date.now()}`;

  beforeAll(async () => {
    receiver = await OtlpReceiver.start();
    api = await startApiProcess({ DATABASE_URL: database.url, ...exportingTo(receiver) });
    const { accessToken } = await signIn(api.baseUrl, `logged-${Date.now()}@example.test`);
    await fetch(`${api.baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${accessToken}`, 'x-request-id': requestId },
    });
  });

  afterAll(async () => {
    await api.stop();
    await receiver.stop();
  });

  const completedLine = () =>
    api.output
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.request_id === requestId && entry.msg === 'request completed');

  it('carry the trace and span ids of the request, and the user id', async () => {
    const line = await receiver.waitFor(completedLine);
    const span = await receiver.waitFor(() =>
      receiver.spans().find((candidate) => candidate.attributes['request.id'] === requestId),
    );

    expect(line).toMatchObject({
      trace_id: span.traceId,
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      trace_flags: '01',
      user_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('reach the collector over OTLP, linked to the trace', async () => {
    const line = await receiver.waitFor(completedLine);

    const record = await receiver.waitFor(() =>
      receiver
        .logs()
        .find(
          (candidate) =>
            candidate.attributes.request_id === requestId && candidate.body === 'request completed',
        ),
    );

    expect(record.traceId).toBe(line.trace_id);
    expect(record.attributes.user_id).toBe(line.user_id);
  });
});
