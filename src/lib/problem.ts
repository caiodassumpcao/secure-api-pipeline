import { STATUS_CODES } from 'node:http';
import { z } from 'zod';

/** RFC 9457 media type. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Problem `type` URIs resolve to human-readable documentation (RFC 9457 §3.1.1). */
export const PROBLEM_TYPE_BASE_URI =
  'https://github.com/caiodassumpcao/secure-api-pipeline/blob/main/docs/problems.md#';

export interface ProblemType {
  readonly slug: string;
  readonly title: string;
  readonly status: number;
}

export const ProblemTypes = {
  badRequest: { slug: 'bad-request', title: 'Bad Request', status: 400 },
  validation: { slug: 'validation-error', title: 'Validation Failed', status: 400 },
  notFound: { slug: 'not-found', title: 'Not Found', status: 404 },
  payloadTooLarge: { slug: 'payload-too-large', title: 'Payload Too Large', status: 413 },
  unsupportedMediaType: {
    slug: 'unsupported-media-type',
    title: 'Unsupported Media Type',
    status: 415,
  },
  internal: { slug: 'internal-error', title: 'Internal Server Error', status: 500 },
} as const satisfies Record<string, ProblemType>;

export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string(),
  traceId: z.string(),
  errors: z.array(fieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/**
 * An error that maps to a specific problem response. Services throw it; the
 * error handler turns it into `application/problem+json`.
 */
export class HttpProblem extends Error {
  readonly problemType: ProblemType;
  readonly detail: string | undefined;
  readonly errors: readonly FieldError[] | undefined;

  constructor(problemType: ProblemType, detail?: string, errors?: readonly FieldError[]) {
    super(detail ?? problemType.title);
    this.name = 'HttpProblem';
    this.problemType = problemType;
    this.detail = detail;
    this.errors = errors;
  }
}

export interface ProblemContext {
  readonly instance: string;
  readonly traceId: string;
  readonly detail?: string | undefined;
  readonly errors?: readonly FieldError[] | undefined;
}

export function buildProblem(problemType: ProblemType, context: ProblemContext): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE_URI}${problemType.slug}`,
    title: problemType.title,
    status: problemType.status,
    ...(context.detail === undefined ? {} : { detail: context.detail }),
    instance: context.instance,
    traceId: context.traceId,
    ...(context.errors === undefined ? {} : { errors: [...context.errors] }),
  };
}

/**
 * Problem for a status without a dedicated type. RFC 9457 §4.2.1: `about:blank`
 * with the HTTP status phrase as title.
 */
export function buildGenericProblem(status: number, context: ProblemContext): ProblemDetails {
  return {
    type: 'about:blank',
    // Numeric lookup in Node's static status table, not user-controlled keys.
    // eslint-disable-next-line security/detect-object-injection
    title: STATUS_CODES[status] ?? 'Error',
    status,
    ...(context.detail === undefined ? {} : { detail: context.detail }),
    instance: context.instance,
    traceId: context.traceId,
  };
}
