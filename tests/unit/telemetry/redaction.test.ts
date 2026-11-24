import { SpanStatusCode, trace } from '@opentelemetry/api';
import { TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import { isUntracedPath, redactedQuery } from '../../../src/telemetry/instrumentations.ts';
import { RedactingSpanExporter, redactSpan } from '../../../src/telemetry/redaction.ts';
import { CollectingSpanExporter } from '../../helpers/telemetry.ts';

function finishedSpan(): ReadableSpan {
  const provider = new TracerProvider();
  const span = provider.getTracer('test').startSpan('request', {
    attributes: {
      'http.request.header.authorization': 'Bearer abc',
      'http.request.header.cookie': '__Secure-refresh=xyz',
      'app.password': 'hunter2',
      'url.path': '/v1/workspaces?access_token=leaked',
      'url.full': 'https://api.example.com/v1/x?token=leaked&limit=5',
      'http.route': '/v1/workspaces',
      'user.id': '0190f3b2-7c1e-7d2a-9f00-1234567890ab',
    },
  });
  span.recordException(new Error('invalid input syntax for type uuid: "secret-input"'));
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'Failed query: params: hunter2' });
  span.end();
  return span as unknown as ReadableSpan;
}

describe('span redaction', () => {
  it('drops credentials, query values, exception texts and the status message', () => {
    const span = finishedSpan();

    const redacted = redactSpan(span);

    expect(redacted.attributes).toEqual({
      'url.path': '/v1/workspaces',
      'url.full': 'https://api.example.com/v1/x?token=[REDACTED]&limit=5',
      'http.route': '/v1/workspaces',
      'user.id': '0190f3b2-7c1e-7d2a-9f00-1234567890ab',
    });
    expect(redacted.events.map((event) => event.attributes)).toEqual([
      { 'exception.type': 'Error' },
    ]);
    expect(redacted.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(JSON.stringify([redacted.attributes, redacted.events])).not.toMatch(
      /hunter2|leaked|secret-input|abc|xyz/,
    );
  });

  it('keeps the span identity and leaves the original untouched', () => {
    const span = finishedSpan();

    const redacted = redactSpan(span);

    expect(redacted.spanContext()).toEqual(span.spanContext());
    expect(redacted.name).toBe('request');
    expect(span.attributes['app.password']).toBe('hunter2');
  });

  it('is applied by the exporter wrapper', async () => {
    const inner = new CollectingSpanExporter();
    const exporter = new RedactingSpanExporter(inner);

    await new Promise((resolve) => {
      exporter.export([finishedSpan()], resolve);
    });
    await exporter.forceFlush();
    await exporter.shutdown();

    expect(inner.spans[0]?.attributes['app.password']).toBeUndefined();
    expect(trace.getTracer('noop')).toBeDefined();
  });
});

describe('request tracing helpers', () => {
  it.each([
    ['/health/live', true],
    ['/health/ready', true],
    ['/docs/static/index.html', true],
    ['/openapi.json', true],
    ['/v1/me', false],
    ['/v1/workspaces/health', false],
  ])('%s is untraced: %s', (url, untraced) => {
    expect(isUntracedPath(url)).toBe(untraced);
  });

  it('masks sensitive query parameters', () => {
    expect(redactedQuery('/v1/x?limit=5&Access_Token=abc')).toBe('limit=5&Access_Token=[REDACTED]');
    expect(redactedQuery('/v1/x')).toBeUndefined();
  });
});
