import { describe, expect, it } from 'vitest';
import {
  buildGenericProblem,
  buildProblem,
  HttpProblem,
  PROBLEM_TYPE_BASE_URI,
  problemDetailsSchema,
  ProblemTypes,
} from '../../../src/lib/problem.ts';

const context = { instance: '/v1/things', traceId: 'trace-1' };

describe('buildProblem', () => {
  it('builds a documented problem type without optional members', () => {
    const problem = buildProblem(ProblemTypes.notFound, context);

    expect(problem).toEqual({
      type: `${PROBLEM_TYPE_BASE_URI}not-found`,
      title: 'Not Found',
      status: 404,
      instance: '/v1/things',
      traceId: 'trace-1',
    });
    expect(problemDetailsSchema.parse(problem)).toEqual(problem);
  });

  it('includes detail and field errors when given', () => {
    const errors = [{ path: 'body.title', message: 'Required' }];

    const problem = buildProblem(ProblemTypes.validation, { ...context, detail: 'Bad', errors });

    expect(problem).toMatchObject({ status: 400, detail: 'Bad', errors });
    expect(problem.errors).not.toBe(errors);
  });
});

describe('buildGenericProblem', () => {
  it('uses about:blank and the HTTP status phrase (RFC 9457 §4.2.1)', () => {
    expect(buildGenericProblem(409, { ...context, detail: 'Conflict detail' })).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Conflict detail',
      instance: '/v1/things',
      traceId: 'trace-1',
    });
  });

  it('falls back to a neutral title for unknown statuses', () => {
    expect(buildGenericProblem(499, context).title).toBe('Error');
  });
});

describe('HttpProblem', () => {
  it('uses the detail as message, or the title when there is none', () => {
    expect(new HttpProblem(ProblemTypes.notFound, 'Task not found').message).toBe('Task not found');
    expect(new HttpProblem(ProblemTypes.notFound).message).toBe('Not Found');
  });
});
