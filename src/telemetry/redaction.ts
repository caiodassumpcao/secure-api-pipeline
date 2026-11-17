import type { Attributes } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { redactUrl } from '../lib/logger.ts';

/** Attribute keys that may carry credentials, whatever produced them. */
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_.]?key/i;

/** URL attributes whose query string may carry credentials. */
const URL_KEYS = new Set(['url.full', 'http.target', 'http.url']);

/**
 * Exception messages and stack traces can quote input values or bound SQL
 * parameters: spans keep the exception type, the logs keep the details
 * (sanitized) under the same trace id.
 */
const EXCEPTION_TEXT_KEYS = new Set(['exception.message', 'exception.stacktrace']);

function redactValue(key: string, value: Attributes[string]): Attributes[string] {
  if (typeof value !== 'string') return value;
  if (key === 'url.path') return value.split('?', 1)[0];
  return URL_KEYS.has(key) ? redactUrl(value) : value;
}

function redactAttributes(attributes: Attributes | undefined): Attributes {
  return Object.fromEntries(
    Object.entries(attributes ?? {})
      .filter(([key]) => !SENSITIVE_KEY.test(key) && !EXCEPTION_TEXT_KEYS.has(key))
      .map(([key, value]) => [key, redactValue(key, value)]),
  );
}

/**
 * The span as exported: same span, minus credential-named attributes, query
 * strings outside `url.query` (already masked), exception texts and the
 * status message (an error message, possibly with values). The original is
 * left untouched.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  return Object.assign(Object.create(span) as ReadableSpan, {
    attributes: redactAttributes(span.attributes),
    events: span.events.map((event) => ({
      ...event,
      attributes: redactAttributes(event.attributes),
    })),
    status: { code: span.status.code },
  });
}

/**
 * Last line of defence before spans leave the process: instrumentations are
 * configured not to record headers, query values or SQL parameters, and this
 * strips whatever could still carry them.
 */
export class RedactingSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;

  constructor(inner: SpanExporter) {
    this.inner = inner;
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans.map(redactSpan), done);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
