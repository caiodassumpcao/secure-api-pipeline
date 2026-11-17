import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';
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
