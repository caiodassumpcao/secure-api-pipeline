import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { DrizzleQueryError } from 'drizzle-orm';
import { HttpProblem } from '../lib/problem.ts';

const tracer = () => trace.getTracer('secure-api');

/** PostgreSQL error code of a failed query (`23505`, …), if any. */
function databaseCode(error: DrizzleQueryError): string | undefined {
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}

/**
 * Records an error on a span without its message: messages can quote input
 * values or SQL parameters (DrizzleQueryError carries them all). The span gets
 * the error type and, for a failed query, the PostgreSQL code; the sanitized
 * logs keep the rest under the same trace id. Problems the client caused
 * (4xx) do not mark the span as failed.
 */
export function recordError(span: Span, error: unknown): void {
  if (error instanceof HttpProblem) {
    span.setAttribute('error.type', error.problemType.slug);
    if (error.problemType.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    return;
  }
  if (error instanceof DrizzleQueryError) {
    // Its `name` is the generic "Error".
    span.setAttribute('error.type', 'DrizzleQueryError');
    const code = databaseCode(error);
    if (code !== undefined) span.setAttribute('db.response.status_code', code);
  } else {
    span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Runs `operation` in a child span named `name`. */
export async function traced<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    try {
      return await operation();
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

type AsyncMethod = (...args: never[]) => Promise<unknown>;

/**
 * Wraps every method of a service in a span named `<service>.<method>`, so a
 * trace reads HTTP request → service operation → database queries.
 */
export function instrumentService<T extends Record<string, AsyncMethod>>(
  name: string,
  service: T,
): T {
  return Object.fromEntries(
    Object.entries(service).map(([method, implementation]) => [
      method,
      (...args: never[]) => traced(`${name}.${method}`, () => implementation(...args)),
    ]),
  ) as T;
}
