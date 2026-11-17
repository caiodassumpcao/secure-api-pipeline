import { z } from 'zod';
import { ConfigError } from '../config/config.ts';

/**
 * Share of traces kept when OTEL_TRACES_SAMPLER_ARG is not set: safe for
 * production traffic. Development sets 1.0 in `.env.example`.
 */
export const DEFAULT_SAMPLE_RATIO = 0.1;

export interface TelemetryConfig {
  /** False with OTEL_SDK_DISABLED=true: no SDK, no instrumentation, no metrics port. */
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly environment: string;
  /** OTLP/HTTP base URL; nothing is pushed without it. */
  readonly otlpEndpoint: string | undefined;
  /** Root traces kept, 0–1. Incoming trace context is never trusted (ADR-0006). */
  readonly sampleRatio: number;
  readonly metrics: {
    /** Interface of the internal `/metrics` port; the image sets 0.0.0.0. */
    readonly host: string;
    readonly port: number;
    /** How often metrics are pushed over OTLP, when an endpoint is set. */
    readonly exportIntervalMs: number;
  };
}

const telemetryEnvSchema = z
  .object({
    NODE_ENV: z.string().default('development'),
    OTEL_SDK_DISABLED: z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .transform((value) => value === 'true')
      .default(false),
    OTEL_SERVICE_NAME: z.string().min(1).default('secure-api'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' })
      .optional(),
    OTEL_TRACES_SAMPLER: z
      .string()
      .refine(
        () => false,
        'is not supported: the sampler is parent-based trace-id ratio; set OTEL_TRACES_SAMPLER_ARG',
      )
      .optional(),
    OTEL_TRACES_SAMPLER_ARG: z.coerce
      .number({ error: 'must be a number between 0 and 1' })
      .min(0, 'must be a number between 0 and 1')
      .max(1, 'must be a number between 0 and 1')
      .default(DEFAULT_SAMPLE_RATIO),
    OTEL_METRIC_EXPORT_INTERVAL: z.coerce.number().int().min(100).default(60_000),
    METRICS_HOST: z.string().min(1).default('127.0.0.1'),
    METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
    PORT: z.coerce.number().int().optional(),
  })
  .loose()
  .refine((env) => env.PORT === undefined || env.PORT !== env.METRICS_PORT, {
    path: ['METRICS_PORT'],
    message: 'must differ from PORT: metrics are never served on the public port',
  });

/**
 * Telemetry settings, read by the `--import` entry point before the app. The
 * OTel SDK reads the other standard variables itself (OTEL_RESOURCE_ATTRIBUTES,
 * OTEL_EXPORTER_OTLP_TIMEOUT, …). Empty values count as unset; messages never
 * echo values.
 *
 * @throws {ConfigError} when a variable is invalid.
 */
export function loadTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const values = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = telemetryEnvSchema.safeParse(values);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    enabled: !parsed.OTEL_SDK_DISABLED,
    serviceName: parsed.OTEL_SERVICE_NAME,
    environment: parsed.NODE_ENV,
    otlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    sampleRatio: parsed.OTEL_TRACES_SAMPLER_ARG,
    metrics: {
      host: parsed.METRICS_HOST,
      port: parsed.METRICS_PORT,
      exportIntervalMs: parsed.OTEL_METRIC_EXPORT_INTERVAL,
    },
  };
}
