import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { createAppMetrics } from '../../../src/telemetry/metrics.ts';

class TestReader extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

async function collect(reader: TestReader) {
  const { resourceMetrics } = await reader.collect();
  return Object.fromEntries(
    resourceMetrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => [
        metric.descriptor.name,
        (metric.dataPoints as DataPoint<number>[]).map((point) => ({
          attributes: point.attributes,
          value: point.value,
        })),
      ]),
    ),
  );
}

describe('createAppMetrics', () => {
  it('counts business events with fixed labels only', async () => {
    const reader = new TestReader();
    const metrics = createAppMetrics(new MeterProvider({ readers: [reader] }).getMeter('test'));

    metrics.loginFailed('wrong_password');
    metrics.loginFailed('wrong_password');
    metrics.loginFailed('rate_limited');
    metrics.refreshTokenReuseDetected();
    metrics.taskCreated();

    expect(await collect(reader)).toEqual({
      'auth.login.failures': [
        { attributes: { reason: 'wrong_password' }, value: 2 },
        { attributes: { reason: 'rate_limited' }, value: 1 },
      ],
      'auth.token.reuse_detected': [{ attributes: {}, value: 1 }],
      'tasks.created': [{ attributes: {}, value: 1 }],
    });
  });

  it('records nothing without a meter provider', () => {
    expect(() => {
      createAppMetrics().taskCreated();
    }).not.toThrow();
  });
});
