import {
  defaultTextMapGetter,
  ROOT_CONTEXT,
  propagation,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelemetryConfig } from '../../../src/telemetry/config.ts';
import { activeTelemetry, startTelemetry } from '../../../src/telemetry/sdk.ts';
import { CollectingSpanExporter, resetOpenTelemetry } from '../../helpers/telemetry.ts';

const config: TelemetryConfig = {
  enabled: true,
  serviceName: 'secure-api-test',
  environment: 'test',
  otlpEndpoint: undefined,
  sampleRatio: 1,
};

afterEach(async () => {
  await activeTelemetry()?.shutdown(100);
  resetOpenTelemetry();
});

const tracer = (): Tracer => trace.getTracer('test');

describe('startTelemetry', () => {
  it('exports spans with the service resource', async () => {
    const exporter = new CollectingSpanExporter();
    const telemetry = startTelemetry(config, { spanExporter: exporter });

    tracer().startSpan('work').end();
    await telemetry.shutdown();

    expect(exporter.spans.map((span) => span.name)).toEqual(['work']);
    expect(exporter.spans[0]?.resource.attributes).toMatchObject({
      'service.name': 'secure-api-test',
      'service.version': expect.stringMatching(/^\d+\.\d+\.\d+/),
      'deployment.environment.name': 'test',
    });
  });

  it('still gives unsampled requests a trace id, for log correlation', async () => {
    const exporter = new CollectingSpanExporter();
    const telemetry = startTelemetry({ ...config, sampleRatio: 0 }, { spanExporter: exporter });

    const span = tracer().startSpan('dropped');
    span.end();
    await telemetry.shutdown();

    expect(span.isRecording()).toBe(false);
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(exporter.spans).toEqual([]);
  });

  it('creates spans without exporting them when no endpoint is set', () => {
    startTelemetry(config);

    const span = tracer().startSpan('local');

    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000');
    span.end();
  });

  it('never trusts trace context sent by clients', () => {
    startTelemetry(config);
    const carrier = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      baggage: 'role=admin',
    };

    const extracted = propagation.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);

    expect(trace.getSpanContext(extracted)).toBeUndefined();
    expect(propagation.getBaggage(extracted)).toBeUndefined();
  });

  it('shuts down within its timeout even if the exporter hangs', async () => {
    const hanging: SpanExporter = {
      export: () => undefined, // never reports back
      shutdown: () => new Promise<void>(() => undefined),
    };
    const telemetry = startTelemetry(config, { spanExporter: hanging });
    tracer().startSpan('stuck').end();

    const started = Date.now();
    await telemetry.shutdown(200);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(activeTelemetry()).toBeUndefined();
  });
});
