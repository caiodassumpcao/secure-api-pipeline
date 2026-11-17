import { readFileSync } from 'node:fs';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { resourceAttributesEnvDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { z } from 'zod';
import type { TelemetryConfig } from './config.ts';
import { RedactingSpanExporter } from './redaction.ts';

/** `package.json` two levels up from both `src/telemetry` and `dist/telemetry`. */
const packageJson = new URL('../../package.json', import.meta.url);
// Fixed path inside the build output, not user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const packageJsonText = readFileSync(packageJson, 'utf8');
const { version } = z.object({ version: z.string() }).parse(JSON.parse(packageJsonText));

/** Budget for flushing telemetry during the graceful shutdown. */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 3_000;

export interface Telemetry {
  /** Flushes and stops every signal; never rejects, never waits longer than the timeout. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface TelemetryOverrides {
  readonly instrumentations?: Instrumentation[];
  /** Replace the OTLP exporters (tests). */
  readonly spanExporter?: SpanExporter;
  readonly logExporter?: LogRecordExporter;
  /** Replace the Prometheus and OTLP metric readers (tests). */
  readonly metricReaders?: IMetricReader[];
}

// The SDK registers process-wide providers; the process entry points reach the
// running instance through this module (one per process, by design of OTel).
let active: Telemetry | undefined;

export function activeTelemetry(): Telemetry | undefined {
  return active;
}

function spanProcessors(config: TelemetryConfig, overrides: TelemetryOverrides): SpanProcessor[] {
  const exporter =
    overrides.spanExporter ??
    (config.otlpEndpoint === undefined ? undefined : new OTLPTraceExporter());
  // Without an exporter, spans are still created (and sampled) so logs carry
  // their trace ids; they are just not sent anywhere.
  return exporter === undefined
    ? [new NoopSpanProcessor()]
    : [
        new BatchSpanProcessor({
          exporter: new RedactingSpanExporter(exporter),
          maxQueueSize: 2_048,
          exportTimeoutMillis: 10_000,
        }),
      ];
}

/**
 * Log records reach Loki over OTLP when an endpoint is set (DESIGN §6). They
 * are taken from pino's serialized output, after redaction. stdout keeps the
 * same lines: collecting it too would store every line twice.
 */
function logRecordProcessors(
  config: TelemetryConfig,
  overrides: TelemetryOverrides,
): LogRecordProcessor[] {
  const exporter =
    overrides.logExporter ??
    (config.otlpEndpoint === undefined ? undefined : new OTLPLogExporter());
  return exporter === undefined
    ? []
    : [new BatchLogRecordProcessor({ exporter, maxQueueSize: 2_048, exportTimeoutMillis: 10_000 })];
}

/**
 * Metrics are always served for Prometheus on the internal port (DESIGN §6),
 * on their own HTTP server, never through the API's port or the public proxy.
 * With an OTLP endpoint they are also pushed, which is how the local Grafana
 * stack receives them.
 */
function metricReaders(config: TelemetryConfig, overrides: TelemetryOverrides): IMetricReader[] {
  if (overrides.metricReaders !== undefined) return overrides.metricReaders;
  const readers: IMetricReader[] = [
    new PrometheusExporter({
      host: config.metrics.host,
      port: config.metrics.port,
      endpoint: '/metrics',
    }),
  ];
  if (config.otlpEndpoint !== undefined) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: config.metrics.exportIntervalMs,
        exportTimeoutMillis: Math.min(10_000, config.metrics.exportIntervalMs),
      }),
    );
  }
  return readers;
}

/**
 * Starts the OpenTelemetry SDK (ADR-0006). Incoming trace context is never
 * extracted (`textMapPropagator: null`): clients cannot choose trace ids,
 * force sampling or inject baggage. Root traces are sampled at
 * `config.sampleRatio`. Exports run in the background with bounded queues, so
 * a slow or failing collector never delays a request.
 */
export function startTelemetry(
  config: TelemetryConfig,
  overrides: TelemetryOverrides = {},
): Telemetry {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: version,
      'deployment.environment.name': config.environment,
    }),
    // OTEL_RESOURCE_ATTRIBUTES can add attributes; no host or cloud probing.
    resourceDetectors: [resourceAttributesEnvDetector],
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRatio),
    }),
    textMapPropagator: null,
    spanProcessors: spanProcessors(config, overrides),
    metricReaders: metricReaders(config, overrides),
    logRecordProcessors: logRecordProcessors(config, overrides),
    instrumentations: overrides.instrumentations ?? [],
  });
  sdk.start();

  const telemetry: Telemetry = {
    async shutdown(timeoutMs = TELEMETRY_SHUTDOWN_TIMEOUT_MS) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs).unref();
      });
      await Promise.race([sdk.shutdown().catch(() => undefined), timeout]);
      clearTimeout(timer);
      if (active === telemetry) active = undefined;
    },
  };
  active = telemetry;
  return telemetry;
}
