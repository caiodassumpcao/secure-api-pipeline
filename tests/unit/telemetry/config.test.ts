import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/config.ts';
import { DEFAULT_SAMPLE_RATIO, loadTelemetryConfig } from '../../../src/telemetry/config.ts';

function issues(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadTelemetryConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadTelemetryConfig', () => {
  it('defaults to a production-safe sample ratio and no export', () => {
    expect(loadTelemetryConfig({})).toEqual({
      enabled: true,
      serviceName: 'secure-api',
      environment: 'development',
      otlpEndpoint: undefined,
      sampleRatio: DEFAULT_SAMPLE_RATIO,
      metrics: { host: '127.0.0.1', port: 9464, exportIntervalMs: 60_000 },
    });
    expect(DEFAULT_SAMPLE_RATIO).toBeLessThanOrEqual(0.1);
  });

  it('reads the standard variables, empty values counting as unset', () => {
    const config = loadTelemetryConfig({
      NODE_ENV: 'production',
      OTEL_SDK_DISABLED: 'true',
      OTEL_SERVICE_NAME: 'api',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-lgtm:4318',
      OTEL_TRACES_SAMPLER_ARG: '1.0',
      OTEL_RESOURCE_ATTRIBUTES: '',
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      METRICS_HOST: '0.0.0.0',
      METRICS_PORT: '9100',
    });

    expect(config).toEqual({
      enabled: false,
      serviceName: 'api',
      environment: 'production',
      otlpEndpoint: 'http://otel-lgtm:4318',
      sampleRatio: 1,
      metrics: { host: '0.0.0.0', port: 9100, exportIntervalMs: 15_000 },
    });
  });

  it.each([
    [
      { OTEL_TRACES_SAMPLER_ARG: '1.5' },
      'OTEL_TRACES_SAMPLER_ARG: must be a number between 0 and 1',
    ],
    [
      { OTEL_TRACES_SAMPLER_ARG: 'all' },
      'OTEL_TRACES_SAMPLER_ARG: must be a number between 0 and 1',
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://collector:4317' },
      'OTEL_EXPORTER_OTLP_ENDPOINT: must be an http:// or https:// URL',
    ],
    [{ OTEL_SDK_DISABLED: 'yes' }, 'OTEL_SDK_DISABLED: must be true or false'],
    [
      { PORT: '3000', METRICS_PORT: '3000' },
      'METRICS_PORT: must differ from PORT: metrics are never served on the public port',
    ],
    [
      { OTEL_TRACES_SAMPLER: 'always_on' },
      'OTEL_TRACES_SAMPLER: is not supported: the sampler is parent-based trace-id ratio; set OTEL_TRACES_SAMPLER_ARG',
    ],
  ])('rejects %o', (env, issue) => {
    expect(issues(env)).toEqual([issue]);
  });
});
