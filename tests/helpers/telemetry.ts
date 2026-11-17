import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import type { TelemetryConfig } from '../../src/telemetry/config.ts';
import {
  startTelemetry,
  type Telemetry,
  type TelemetryOverrides,
} from '../../src/telemetry/sdk.ts';

/** Unregisters the process-wide OpenTelemetry providers, so each test starts clean. */
export function resetOpenTelemetry(): void {
  trace.disable();
  metrics.disable();
  logs.disable();
  propagation.disable();
  context.disable();
}

/** Keeps every exported span; unlike InMemorySpanExporter, survives shutdown. */
export class CollectingSpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export const TEST_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  serviceName: 'secure-api-test',
  environment: 'test',
  otlpEndpoint: undefined,
  sampleRatio: 1,
  metrics: { host: '127.0.0.1', port: 9464, exportIntervalMs: 60_000 },
};

/** The real SDK, without the Prometheus port (tests run in parallel). */
export function startTestTelemetry(
  overrides: TelemetryOverrides = {},
  config: Partial<TelemetryConfig> = {},
): Telemetry {
  return startTelemetry(
    { ...TEST_TELEMETRY_CONFIG, ...config },
    { metricReaders: [], ...overrides },
  );
}
