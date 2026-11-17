import { readFileSync } from 'node:fs';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { resourceAttributesEnvDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { z } from 'zod';
import type { TelemetryConfig } from './config.ts';

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
  /** Replaces the OTLP span exporter (tests). */
  readonly spanExporter?: SpanExporter;
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
    : [new BatchSpanProcessor({ exporter, maxQueueSize: 2_048, exportTimeoutMillis: 10_000 })];
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
    metricReaders: [],
    logRecordProcessors: [],
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
