import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../integration/helpers/database.ts';
import { exportingTo, OtlpReceiver } from '../integration/helpers/otlp-receiver.ts';
import { startApiProcess, type ApiProcess } from '../integration/helpers/process.ts';

/**
 * Telemetry never carries secrets or personal data beyond opaque ids
 * (DESIGN §6, ADR-0006). A full authentication flow runs against the real
 * process exporting everything; then every exported span, log record and
 * metric, the /metrics page and stdout are searched for each secret it used.
 */

const PASSWORD = 'a telemetry secret passphrase';
const WRONG_PASSWORD = 'a mistyped secret passphrase';
const QUERY_SECRET = 'query-string-secret-value';
const NAME = 'Telemetry Personal Name';
const json = { 'content-type': 'application/json' };

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function cookieValue(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  return header?.slice(name.length + 1).split(';', 1)[0] ?? '';
}

/** Sends a request and fails the setup unless it gets the expected status. */
async function call(url: string, init: RequestInit, expected: number): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== expected) {
    throw new Error(`${init.method ?? 'GET'} ${url}: ${response.status}, expected ${expected}`);
  }
  return response;
}

describe('exported telemetry', () => {
  let receiver: OtlpReceiver;
  let api: ApiProcess;
  let exposition = '';
  const secrets: string[] = [];

  beforeAll(async () => {
    receiver = await OtlpReceiver.start();
    api = await startApiProcess({ DATABASE_URL: database.url, ...exportingTo(receiver) });
    const url = (path: string) => `${api.baseUrl}${path}`;
    const bearer = (token: string) => ({ ...json, authorization: `Bearer ${token}` });

    async function account(email: string) {
      const body = JSON.stringify({ email, password: PASSWORD, name: NAME });
      await call(url('/v1/auth/register'), { method: 'POST', headers: json, body }, 201);
      // A taken address fails on the unique constraint: a database error path.
      await call(url('/v1/auth/register'), { method: 'POST', headers: json, body }, 409);
      const login = await call(
        url('/v1/auth/login'),
        { method: 'POST', headers: json, body: JSON.stringify({ email, password: PASSWORD }) },
        200,
      );
      const { accessToken } = (await login.json()) as { accessToken: string };
      return {
        email,
        accessToken,
        refreshToken: cookieValue(login, '__Secure-refresh'),
        deviceToken: cookieValue(login, '__Secure-device'),
      };
    }

    const owner = await account(`owner-${Date.now()}@example.test`);
    const guest = await account(`guest-${Date.now()}@example.test`);
    const me = await call(url('/v1/me'), { headers: bearer(owner.accessToken) }, 200);
    const { memberships } = (await me.json()) as { memberships: { workspaceId: string }[] };
    const invited = await call(
      url(`/v1/workspaces/${memberships[0]?.workspaceId ?? ''}/invitations`),
      {
        method: 'POST',
        headers: bearer(owner.accessToken),
        body: JSON.stringify({ role: 'member', email: guest.email }),
      },
      201,
    );
    const invitation = (await invited.json()) as { token: string };
    await call(
      url('/v1/invitations/accept'),
      {
        method: 'POST',
        headers: bearer(guest.accessToken),
        body: JSON.stringify({ token: invitation.token }),
      },
      201,
    );
    const refreshed = await call(
      url('/v1/auth/refresh'),
      { method: 'POST', headers: { cookie: `__Secure-refresh=${owner.refreshToken}` } },
      200,
    );
    const { accessToken: refreshedToken } = (await refreshed.json()) as { accessToken: string };
    const rotatedToken = cookieValue(refreshed, '__Secure-refresh');
    // Strict query schemas refuse it, but the URL is still traced and logged.
    await call(
      url(`/v1/workspaces?access_token=${QUERY_SECRET}`),
      { headers: bearer(refreshedToken) },
      400,
    );
    await call(
      url('/v1/auth/login'),
      {
        method: 'POST',
        headers: { ...json, cookie: `__Secure-device=${guest.deviceToken}` },
        body: JSON.stringify({ email: guest.email, password: WRONG_PASSWORD }),
      },
      401,
    );
    await call(
      url('/v1/auth/logout'),
      { method: 'POST', headers: { cookie: `__Secure-refresh=${rotatedToken}` } },
      204,
    );

    secrets.push(
      PASSWORD,
      WRONG_PASSWORD,
      QUERY_SECRET,
      NAME,
      owner.email,
      guest.email,
      owner.accessToken,
      owner.refreshToken,
      owner.deviceToken,
      guest.accessToken,
      guest.refreshToken,
      guest.deviceToken,
      refreshedToken,
      rotatedToken,
      invitation.token,
    );
    // Everything up to the last request has been exported.
    await receiver.waitFor(() =>
      receiver.spans().some((span) => span.attributes['http.route'] === '/v1/auth/logout') &&
      receiver.logs().some((log) => String(log.body).includes('request completed')) &&
      receiver.metricNames().includes('auth.login.failures')
        ? true
        : undefined,
    );
    exposition = await (await fetch(api.metricsUrl)).text();
  });

  afterAll(async () => {
    await api.stop();
    await receiver.stop();
  });

  it('covers the whole flow', () => {
    expect(secrets.every((secret) => secret.length >= 20)).toBe(true);
    expect(receiver.spans().some((span) => span.scope.includes('pg'))).toBe(true);
    expect(exposition).toContain('auth_login_failures_total');
  });

  it.each([
    ['exported spans, logs and metrics', () => receiver.bodies.join('\n')],
    ['the /metrics page', () => exposition],
    ['stdout', () => api.output.join('\n')],
  ])('never carry a secret or personal data in %s', (_where, read) => {
    const text = read();

    expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
  });

  it('record no request headers and no error messages', () => {
    const spans = receiver.spans();
    const keys = spans.flatMap((span) => [
      ...Object.keys(span.attributes),
      ...span.events.flatMap((event) => Object.keys(event.attributes)),
    ]);

    expect(keys.filter((key) => /header|cookie|authorization|exception\./i.test(key))).toEqual([]);
    expect(spans.filter((span) => span.status?.message !== undefined)).toEqual([]);
  });
});

describe('an unreachable collector', () => {
  let blackHole: Server;
  const sockets = new Set<Socket>();
  let api: ApiProcess;

  beforeAll(async () => {
    // Accepts connections and never answers, like a collector that hangs.
    blackHole = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => {
      blackHole.listen(0, '127.0.0.1', resolve);
    });
    const address = blackHole.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    api = await startApiProcess({
      DATABASE_URL: database.url,
      ...exportingTo({ url: `http://127.0.0.1:${port}` } as OtlpReceiver),
    });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      blackHole.close(() => {
        resolve();
      });
    });
  });

  it('does not slow requests down', async () => {
    const started = performance.now();
    const statuses: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      statuses.push((await fetch(`${api.baseUrl}/v1/me`)).status);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(statuses.every((status) => status === 401)).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('does not keep the process from shutting down', async () => {
    const started = performance.now();

    expect(await api.stop()).toBe(0);
    expect(performance.now() - started).toBeLessThan(8_000);
  });
});
