import { FastifyOtelInstrumentation } from '@fastify/otel';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { redactUrl } from '../lib/logger.ts';

/** Probes and docs: frequent or static, not worth a trace or a metric series. */
const UNTRACED_PREFIXES = ['/health/', '/docs', '/openapi.json'];

export function isUntracedPath(url: string): boolean {
  return UNTRACED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** The query string of a request URL, with sensitive parameter values masked. */
export function redactedQuery(url: string): string | undefined {
  const redacted = redactUrl(url);
  const start = redacted.indexOf('?');
  return start === -1 ? undefined : redacted.slice(start + 1);
}

/**
 * Explicit instrumentations, not the auto-instrumentation bundle (ADR-0006).
 * HTTP server spans record no headers, and their query string is masked like
 * in the logs. @fastify/otel names the request after its route template
 * (`GET /v1/workspaces/:wsId`), never the raw URL, without one span per hook.
 * Exceptions are not recorded by the framework: their messages can hold
 * values (see src/telemetry/traced.ts).
 */
export function createInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      // No outgoing calls today; the exporters' own requests are not traced.
      disableOutgoingRequestInstrumentation: true,
      ignoreIncomingRequestHook: (request) => isUntracedPath(request.url ?? ''),
      requestHook: (span, request) => {
        if (!('url' in request) || request.url === undefined) return;
        const query = redactedQuery(request.url);
        if (query !== undefined) span.setAttribute('url.query', query);
      },
    }),
    new FastifyOtelInstrumentation({
      registerOnInitialization: true,
      instrumentHooks: false,
      instrumentHandler: false,
      recordExceptions: false,
      ignorePaths: (route) => isUntracedPath(route.url),
      requestHook: (span, request) => {
        span.setAttribute('request.id', request.id);
        // @fastify/otel records the raw URL as the path, query string included.
        span.setAttribute('url.path', request.url.split('?', 1)[0] ?? '');
      },
    }),
  ];
}
