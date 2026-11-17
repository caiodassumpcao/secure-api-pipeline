import { SpanStatusCode, trace } from '@opentelemetry/api';
import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProblem, ProblemTypes } from '../../../src/lib/problem.ts';
import { activeTelemetry, startTelemetry, type Telemetry } from '../../../src/telemetry/sdk.ts';
import { instrumentService, traced } from '../../../src/telemetry/traced.ts';
import { CollectingSpanExporter, resetOpenTelemetry } from '../../helpers/telemetry.ts';

let exporter: CollectingSpanExporter;
let telemetry: Telemetry;

beforeEach(() => {
  exporter = new CollectingSpanExporter();
  telemetry = startTelemetry(
    {
      enabled: true,
      serviceName: 'test',
      environment: 'test',
      otlpEndpoint: undefined,
      sampleRatio: 1,
    },
    { spanExporter: exporter },
  );
});

afterEach(async () => {
  await activeTelemetry()?.shutdown(100);
  resetOpenTelemetry();
});

async function exported() {
  await telemetry.shutdown();
  return exporter.spans;
}

describe('instrumentService', () => {
  it('wraps each method in a span named after the service and method', async () => {
    const service = instrumentService('workspaces', {
      get: (id: string) => Promise.resolve({ id }),
      list: () => Promise.resolve([]),
    });

    await expect(service.get('ws-1')).resolves.toEqual({ id: 'ws-1' });
    await service.list();

    expect((await exported()).map((span) => span.name)).toEqual([
      'workspaces.get',
      'workspaces.list',
    ]);
  });

  it('makes work inside a method a child of its span', async () => {
    const service = instrumentService('tasks', {
      create: () => traced('db.insert', () => Promise.resolve('task')),
    });

    await service.create();

    const [child, parent] = await exported();
    expect(child?.name).toBe('db.insert');
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });
});

describe('errors on spans', () => {
  const failing = (error: unknown) =>
    instrumentService('svc', {
      run: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    });

  it('client problems record their type without failing the span', async () => {
    await expect(
      failing(new HttpProblem(ProblemTypes.notFound, 'No such task.')).run(),
    ).rejects.toThrow();

    const [span] = await exported();
    expect(span?.attributes).toEqual({ 'error.type': 'not-found' });
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('server failures fail the span, with the type and no message', async () => {
    await expect(failing(new TypeError('cannot read secret-value')).run()).rejects.toThrow();

    const [span] = await exported();
    expect(span?.attributes).toEqual({ 'error.type': 'TypeError' });
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(JSON.stringify([span?.attributes, span?.events, span?.status])).not.toContain(
      'secret-value',
    );
  });

  it('failed queries keep the PostgreSQL code, never the bound values', async () => {
    const cause = Object.assign(new Error('duplicate key'), { code: '23505' });
    const error = new DrizzleQueryError(
      'insert into users values ($1)',
      ['ana@example.com'],
      cause,
    );

    await expect(failing(error).run()).rejects.toBe(error);

    const [span] = await exported();
    expect(span?.attributes).toEqual({
      'error.type': 'DrizzleQueryError',
      'db.response.status_code': '23505',
    });
    expect(JSON.stringify([span?.attributes, span?.events])).not.toContain('ana@example.com');
  });

  it('records nothing when tracing is off', async () => {
    await telemetry.shutdown();
    resetOpenTelemetry();

    await expect(traced('noop', () => Promise.resolve(1))).resolves.toBe(1);
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});
