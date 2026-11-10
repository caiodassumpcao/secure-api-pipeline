import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { healthRoutes } from '../../../../src/modules/health/health.routes.ts';
import { buildTestApp } from '../../../helpers/test-app.ts';

describe('GET /health/live', () => {
  it('reports the process as alive without touching the database', async () => {
    const { app, ping } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when the database answers', async () => {
    const { app, ping } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('returns 503 and logs a warning when the database is down', async () => {
    const { app, logs } = await buildTestApp({
      ping: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', checks: { database: 'unavailable' } });
    expect(response.body).not.toContain('10.0.0.5');
    expect(logs.entries.find((entry) => entry.level === 'warn')).toMatchObject({
      msg: 'readiness check failed: database unavailable',
      err: { message: expect.stringContaining('ECONNREFUSED') },
    });
  });

  it('returns 503 when the database does not answer in time', async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const ping = vi.fn(() => new Promise<void>(() => undefined));
    await app.register(healthRoutes, { database: { ping }, readinessTimeoutMs: 10 });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
  });

  it('does not log successful probes at info level', async () => {
    const { app, logs } = await buildTestApp();

    await app.inject({ method: 'GET', url: '/health/ready' });
    await app.inject({ method: 'GET', url: '/health/live' });

    expect(logs.entries.filter((entry) => 'request_id' in entry)).toEqual([]);
  });
});
