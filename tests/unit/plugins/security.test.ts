import { describe, expect, it } from 'vitest';
import type { AppDependencies } from '../../../src/app.ts';
import { buildTestApp } from '../../helpers/test-app.ts';

const ALLOWED = 'https://app.example.com';

describe('security headers', () => {
  it('lock down every response of the JSON API', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.headers).toMatchObject({
      'content-security-policy':
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'strict-transport-security': expect.stringContaining('max-age='),
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
  });

  it('also apply to error responses', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/nowhere' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('CORS', () => {
  const preflight = (origin: string) => ({
    method: 'OPTIONS' as const,
    url: '/v1/workspaces',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

  it('is off when no origin is configured', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: ALLOWED },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows listed origins, with credentials for the refresh cookie', async () => {
    const { app } = await buildTestApp({ http: { corsOrigins: [ALLOWED] } });

    const response = await app.inject(preflight(ALLOWED));

    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': ALLOWED,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
    });
  });

  it('gives other origins no CORS headers', async () => {
    const { app } = await buildTestApp({ http: { corsOrigins: [ALLOWED] } });

    const response = await app.inject(preflight('https://evil.example'));

    // Without a matching Access-Control-Allow-Origin, browsers block the
    // response whatever the other CORS headers say.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('client IP behind proxies', () => {
  const PROXY = '10.0.0.5';
  const CLIENT = '203.0.113.7';

  async function ipSeenBy(
    trustProxy: AppDependencies['http']['trustProxy'],
    remoteAddress: string,
    forwardedFor: string,
  ) {
    const { app } = await buildTestApp({ http: { trustProxy } });
    app.get('/test/ip', (request) => ({ ip: request.ip }));

    const response = await app.inject({
      method: 'GET',
      url: '/test/ip',
      remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return response.json<{ ip: string }>().ip;
  }

  it('ignores a forged X-Forwarded-For when no proxy is trusted (the default)', async () => {
    expect(await ipSeenBy(false, CLIENT, '198.51.100.1')).toBe(CLIENT);
  });

  it('takes the client IP from the trusted hops only', async () => {
    // The client forged the first entry; the proxy appended the real one.
    expect(await ipSeenBy(1, PROXY, `198.51.100.1, ${CLIENT}`)).toBe(CLIENT);
  });

  it('trusts listed proxy addresses and ranges, not anyone else', async () => {
    expect(await ipSeenBy(['10.0.0.0/8'], PROXY, CLIENT)).toBe(CLIENT);
    expect(await ipSeenBy(['10.0.0.0/8'], CLIENT, '198.51.100.1')).toBe(CLIENT);
  });
});
