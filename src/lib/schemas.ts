import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE, problemDetailsSchema } from './problem.ts';

export const idSchema = z.uuid();

export const nameSchema = z.string().trim().min(1).max(100);

export const timestampSchema = z.iso.datetime();

/** Requires at least one member in a PATCH body. */
export const notEmpty = (value: object) => Object.keys(value).length > 0;
export const NOT_EMPTY_MESSAGE = 'At least one field must be provided';

const PROBLEM_DESCRIPTIONS = {
  400: 'Malformed request or validation failure',
  401: 'Authentication required',
  403: 'The caller’s role does not allow the action',
  404: 'Not found, or not visible to the caller',
  409: 'Conflict with the current state',
  429: 'Rate limit exceeded; retry after the `Retry-After` delay',
} as const;

type ProblemStatus = keyof typeof PROBLEM_DESCRIPTIONS;

interface ProblemResponse {
  description: string;
  content: { 'application/problem+json': { schema: typeof problemDetailsSchema } };
}

/** OpenAPI documentation (and serializers) for the RFC 9457 error responses of a route. */
export function problemResponses<S extends ProblemStatus>(
  ...statuses: S[]
): Record<S, ProblemResponse> {
  const responses = new Map<S, ProblemResponse>(
    statuses.map((status) => [
      status,
      {
        // Key from the constant table above.
        // eslint-disable-next-line security/detect-object-injection
        description: PROBLEM_DESCRIPTIONS[status],
        content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
      },
    ]),
  );
  return Object.fromEntries(responses) as Record<S, ProblemResponse>;
}

/** 204 response (no body). */
export const noContentSchema = z.null().describe('No content');
