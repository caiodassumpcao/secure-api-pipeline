import { describe, expect, it } from 'vitest';
import { GLOBAL_RATE_LIMIT } from '../../../src/plugins/rate-limit.ts';
import { buildTestApp } from '../../helpers/test-app.ts';

// Each test sends the whole quota (600 requests): some 2.5 s on a quiet
// machine, past the default 5 s when the suite shares a loaded CPU.
describe('global rate limit', { timeout: 20_000 }, () => {
  it('answers 429 problems with Retry-After once an IP exceeds it', async () => {
    const { app } = await buildTestApp({ globalRateLimit: true });
    const request = { method: 'GET' as const, url: '/v1/workspaces', remoteAddress: '203.0.113.7' };

    for (let index = 0; index < GLOBAL_RATE_LIMIT.max; index += 1) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    const limited = await app.inject(request);
    const other = await app.inject({ ...request, remoteAddress: '203.0.113.8' });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json()).toMatchObject({ status: 429, title: 'Too Many Requests' });
    expect(other.statusCode).toBe(401);
  });

  it('runs before routing, so unknown routes count too', async () => {
    const { app } = await buildTestApp({ globalRateLimit: true });
    const request = { method: 'GET' as const, url: '/scan/admin', remoteAddress: '203.0.113.9' };

    for (let index = 0; index < GLOBAL_RATE_LIMIT.max; index += 1) await app.inject(request);

    expect((await app.inject(request)).statusCode).toBe(429);
  });

  it('leaves the health probes alone', async () => {
    const { app } = await buildTestApp({ globalRateLimit: true });

    for (let index = 0; index <= GLOBAL_RATE_LIMIT.max; index += 1) {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    }
  });
});
