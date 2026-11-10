import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  ResponseSerializationError,
} from 'fastify-type-provider-zod';
import {
  buildGenericProblem,
  buildProblem,
  HttpProblem,
  PROBLEM_CONTENT_TYPE,
  ProblemTypes,
  type FieldError,
  type ProblemContext,
  type ProblemDetails,
} from '../lib/problem.ts';
import { REQUEST_ID_HEADER } from './request-id.ts';

const INTERNAL_ERROR_DETAIL = 'An unexpected error occurred.';

interface FastifyLikeError {
  code: string;
  statusCode: number;
  message: string;
}

/** Errors raised by Fastify itself (body parsing, limits, media type). */
function isFastifyError(error: unknown): error is FastifyLikeError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('FST_') &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  );
}

function hasClientErrorStatus(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

/** `/items/0/title` in the `body` context becomes `body.items.0.title`. */
function toFieldPath(context: string | undefined, instancePath: string): string {
  return [context ?? 'request', ...instancePath.split('/').filter(Boolean)].join('.');
}

/** Path only: the query string may carry values that do not belong in a response. */
function instanceOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '/';
}

// Phase 3 replaces the request id with the OpenTelemetry trace id.
function traceIdOf(request: FastifyRequest): string {
  return request.id;
}

export function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  const context: ProblemContext = { instance: instanceOf(request), traceId: traceIdOf(request) };

  if (error instanceof HttpProblem) {
    return buildProblem(error.problemType, {
      ...context,
      detail: error.detail,
      errors: error.errors,
    });
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const errors: FieldError[] = error.validation.map((issue) => ({
      path: toFieldPath(error.validationContext, issue.instancePath),
      message: issue.message ?? 'Invalid value',
    }));
    return buildProblem(ProblemTypes.validation, {
      ...context,
      detail: 'The request does not match the expected schema.',
      errors,
    });
  }

  if (error instanceof ResponseSerializationError) {
    return buildProblem(ProblemTypes.internal, { ...context, detail: INTERNAL_ERROR_DETAIL });
  }

  if (isFastifyError(error) && error.statusCode >= 400 && error.statusCode < 500) {
    const detail = error.message;
    switch (error.statusCode) {
      case 400:
        return buildProblem(ProblemTypes.badRequest, { ...context, detail });
      case 413:
        return buildProblem(ProblemTypes.payloadTooLarge, { ...context, detail });
      case 415:
        return buildProblem(ProblemTypes.unsupportedMediaType, { ...context, detail });
      default:
        return buildGenericProblem(error.statusCode, { ...context, detail });
    }
  }

  // Client errors from other sources keep their status, but not their message,
  // which may describe internals.
  if (hasClientErrorStatus(error)) {
    return buildGenericProblem(error.statusCode, context);
  }

  return buildProblem(ProblemTypes.internal, { ...context, detail: INTERNAL_ERROR_DETAIL });
}

function sendProblem(
  error: unknown,
  problem: ProblemDetails,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (problem.status >= 500) {
    request.log.error({ err: error }, 'request failed');
  } else {
    request.log.info({ err: error }, 'request rejected');
  }
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * Fixed details for router-level errors: their messages embed the raw URL,
 * query string included.
 */
const FRAMEWORK_ERROR_DETAILS = new Map([
  ['FST_ERR_BAD_URL', 'The request URL is malformed.'],
  ['FST_ERR_MAX_PARAM_LENGTH', 'A path parameter is too long.'],
  ['FST_ERR_ASYNC_CONSTRAINT', 'The request could not be routed.'],
]);

/**
 * Fastify `frameworkErrors` option. Router-level errors (malformed URL, path
 * parameter too long) happen before a route exists: Fastify runs neither the
 * hooks nor the error handler for them, so they are rendered here.
 */
export function frameworkErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // The onRequest hook that normally sets it does not run on this path.
  reply.header(REQUEST_ID_HEADER, request.id);
  const status =
    error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 400;
  const context: ProblemContext = {
    instance: instanceOf(request),
    traceId: traceIdOf(request),
    detail: FRAMEWORK_ERROR_DETAILS.get(error.code) ?? 'The request could not be processed.',
  };
  const problem =
    status === 400
      ? buildProblem(ProblemTypes.badRequest, context)
      : buildGenericProblem(status, context);
  // Not `err`: the message holds the raw URL. The `req` serializer masks it.
  request.log.info({ code: error.code, req: request }, 'request rejected');
  void reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * Single error handler: every error becomes an RFC 9457 problem response.
 * Stack traces, SQL and internal messages are logged, never returned.
 * Router-level errors go through {@link frameworkErrorHandler}.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) =>
    sendProblem(error, toProblem(error, request), request, reply),
  );

  app.setNotFoundHandler((request, reply) => {
    const problem = buildProblem(ProblemTypes.notFound, {
      instance: instanceOf(request),
      traceId: traceIdOf(request),
      detail: 'The requested resource does not exist.',
    });
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });
}
